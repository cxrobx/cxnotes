import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreImage
import CoreVideo
import CoreGraphics

/// Exit code used when no capture source could be resolved.
///
/// Distinct from a crash on purpose: "we deliberately captured nothing, and
/// here is why" is a normal outcome that the parent records in the manifest,
/// not a failure it should retry or warn about.
let EXIT_UNRESOLVED: Int32 = 3

/// Exit code used when the capture stream dies mid-session.
let EXIT_STREAM_DIED: Int32 = 4

struct SlideCaptureSettings {
    var outputDirectory: String
    var maxWidth: Int = 1440
    /// Frames per second requested from ScreenCaptureKit. Only keyframes are
    /// ever written; this is the sampling rate of the stability test.
    var fps: Int = 2
    /// How long a picture must hold still before it counts as a slide.
    var stabilityMs: Int = 2000
    /// Hamming distance below which two frames are "the same picture".
    var stableTolerance: Int = 4
    /// Hamming distance a new keyframe must clear against the last kept one.
    var changeThreshold: Int = 12
    /// Mean luminance below which a frame is treated as blank.
    var blankLuminance: Double = 0.02
    /// Wall-clock epoch the recording started, so slide offsets share the
    /// transcript's clock rather than this process's.
    var startEpochMs: Double?
    var jpegQuality: Double = 0.72
    /// How often to OCR the live frame for on-screen names. 0 disables it.
    var speakerSampleMs: Int = 4000
}

/// Captures slide keyframes from ONE window (or one application).
///
/// `@unchecked Sendable` is accurate rather than a shortcut: every piece of
/// keyframe state below is touched only on `frameQueue`, either from the
/// ScreenCaptureKit output callback (which is delivered on that queue) or from
/// a `frameQueue.async` block. Nothing reads it from anywhere else.
@available(macOS 13.0, *)
final class SlideCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let settings: SlideCaptureSettings
    private let resolver: SourceResolver

    private var stream: SCStream?
    private let frameQueue = DispatchQueue(label: "io.cxnotes.slide-capture.frames")
    /// OCR runs here, never on `frameQueue`. Vision on a 1440px frame takes a
    /// couple of hundred milliseconds; spending that on the queue delivering
    /// frames would drop the frames the sample is meant to describe.
    private let ocrQueue = DispatchQueue(label: "io.cxnotes.slide-capture.ocr", qos: .utility)
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    private var currentResolution: Resolution?
    private var lockedShareWindowID: CGWindowID?
    private var reresolveTimer: DispatchSourceTimer?

    // Keyframe state — only touched on frameQueue.
    //
    // ScreenCaptureKit delivers a frame when the window's content CHANGES, not
    // on a clock. A slide on screen is therefore silence, not a stream of
    // identical frames, so "the same picture N times" can never settle and the
    // stability test has to be inverted: hold the most recent frame, and treat
    // the ABSENCE of a newer one for `stabilityMs` as the picture having
    // settled. Motion keeps resetting the timer; a slide lets it fire.
    private var pendingImage: CGImage?
    private var pendingHash: UInt64?
    private var pendingAtMs: Double = 0
    private var settleTimer: DispatchSourceTimer?
    private var lastKeptHash: UInt64?
    private var slideIndex = 0

    private var startEpochMs: Double
    private var csvHandle: FileHandle?
    private var stopped = false
    private var lastUnresolvedReason: String?

    /// The most recent frame, kept separately from the keyframe candidate.
    ///
    /// Keyframing deliberately throws away everything that MOVES, which is
    /// exactly where the on-screen speaker name lives — a name label sits in a
    /// tile that is changing constantly. So the two purposes cannot share a
    /// frame: `pendingImage` is the picture that might become a slide, and this
    /// is simply the latest picture, whatever it is.
    private var latestImage: CGImage?
    private var speakerTimer: DispatchSourceTimer?
    private var speakerHandle: FileHandle?
    private var lastSpeakerLine: String?

    init(settings: SlideCaptureSettings, resolver: SourceResolver) {
        self.settings = settings
        self.resolver = resolver
        self.startEpochMs = settings.startEpochMs ?? (Date().timeIntervalSince1970 * 1000)
        super.init()
    }

    /// Begin. Resolution is retried on the timer rather than demanded up front:
    /// the helper is spawned when RECORDING starts, which is routinely before
    /// the meeting window exists — a link clicked, an app launching, a browser
    /// tab still loading. Exiting on the first miss would mean the sessions
    /// most worth capturing are the ones that capture nothing.
    func start() async throws {
        try prepareOutputDirectory()
        await attachIfPossible()
        startReresolveTimer()
        startSpeakerSampler()
    }

    /// Try to resolve a source and attach a stream to it. Silent no-op while
    /// nothing is resolvable; the reason is reported once, not every tick.
    private func attachIfPossible() async {
        guard stream == nil, !stopped else { return }
        guard let content = try? await Self.shareableContent() else { return }

        let resolution: Resolution
        let shareWindow: CGWindowID?
        do {
            (resolution, shareWindow) = try resolver.resolve(content: content, lockedShareWindowID: lockedShareWindowID)
        } catch let failure as ResolutionFailure {
            if lastUnresolvedReason != failure.reason {
                lastUnresolvedReason = failure.reason
                fputs("STATUS: waiting for a slide source (\(failure.reason))\n", stderr)
                emitEvent(["event": "unresolved", "detail": failure.reason])
            }
            return
        } catch {
            return
        }

        lastUnresolvedReason = nil
        lockedShareWindowID = shareWindow

        do {
            let stream = SCStream(filter: Self.buildFilter(for: resolution), configuration: buildConfiguration(for: resolution), delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
            try await stream.startCapture()
            self.stream = stream
            currentResolution = resolution
            fputs("STATUS: capturing \(resolution.mode) — \(resolution.detail)\n", stderr)
            emitEvent(["event": "resolved", "mode": resolution.mode, "detail": resolution.detail, "title": resolution.describedTitle])
        } catch {
            fputs("WARNING: could not attach to \(resolution.describedTitle): \(error.localizedDescription)\n", stderr)
        }
    }

    func stop() async {
        stopped = true
        reresolveTimer?.cancel()
        reresolveTimer = nil
        speakerTimer?.cancel()
        speakerTimer = nil
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil
        frameQueue.sync {
            // A slide showing when the meeting ends is still a slide — let the
            // pending frame land before the handle closes.
            settleTimer?.cancel()
            settleTimer = nil
            settle()
            try? csvHandle?.close()
            csvHandle = nil
            try? speakerHandle?.close()
            speakerHandle = nil
        }
        fputs("STATUS: slide capture stopped after \(slideIndex) keyframes\n", stderr)
    }

    /// Periodically read whatever text is on screen, for the names in it.
    ///
    /// This helper does NOT try to decide which string is a person's name. It
    /// samples and writes; interpretation happens in JavaScript, where the
    /// meeting roster is known and where the heuristics can be tested. Keeping
    /// the guessing out of the capture process is what stops a wrong name being
    /// baked into the only copy of the evidence.
    private func startSpeakerSampler() {
        guard settings.speakerSampleMs > 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: frameQueue)
        let interval = DispatchTimeInterval.milliseconds(settings.speakerSampleMs)
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler { [weak self] in
            self?.sampleScreenText()
        }
        timer.resume()
        speakerTimer = timer
    }

    private func sampleScreenText() {
        guard let image = latestImage, speakerHandle != nil else { return }
        let offsetMs = max(0, Int(Date().timeIntervalSince1970 * 1000 - startEpochMs))
        let mode = currentResolution?.mode ?? "unknown"

        ocrQueue.async { [weak self] in
            // `.accurate`, not `.fast`: a participant nameplate is small text on
            // a compressed video tile, and `.fast` reduced clean 12pt text to
            // "Untitl<?> 2 | He vetica" in situ. A name read wrongly is worse
            // than no name, and this runs once every few seconds.
            guard let lines = SlideOCR.recogniseText(in: image, level: .accurate), !lines.isEmpty else { return }

            // Names sit in short labels; long lines are slide body text and only
            // make the file bigger and the JS side's job harder.
            let candidates = lines
                .filter { (2...48).contains($0.count) }
                .prefix(40)
            guard !candidates.isEmpty else { return }

            let joined = candidates
                .map { $0.replacingOccurrences(of: "|", with: "/") }
                .joined(separator: "|")

            self?.frameQueue.async {
                guard let self, let handle = self.speakerHandle else { return }
                // A static screen produces the same sample every tick; one row
                // per CHANGE is all the timeline needs.
                guard joined != self.lastSpeakerLine else { return }
                self.lastSpeakerLine = joined
                handle.write(Data("\(offsetMs),\(mode),\"\(joined.replacingOccurrences(of: "\"", with: "'"))\"\n".utf8))
            }
        }
    }

    // MARK: - Source tracking

    /// Re-check the source periodically. Two things can change under us: the
    /// user starts or stops sharing (which moves the slides into a different
    /// application), and a browser window navigates away from the meeting
    /// (which must stop capture, not keep filming whatever replaced it).
    private func startReresolveTimer() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            Task { await self.reresolve() }
        }
        timer.resume()
        reresolveTimer = timer
    }

    private func reresolve() async {
        guard !stopped else { return }
        guard let stream else {
            // Detached — either we have not attached yet, or the source was
            // lost and we are waiting for it to come back.
            await attachIfPossible()
            return
        }
        guard let content = try? await Self.shareableContent() else { return }

        do {
            let (resolution, shareWindow) = try resolver.resolve(
                content: content,
                lockedShareWindowID: lockedShareWindowID
            )
            lockedShareWindowID = shareWindow

            let changed = resolution.windowID != currentResolution?.windowID
                || resolution.mode != currentResolution?.mode
            guard changed else { return }

            try await stream.updateContentFilter(Self.buildFilter(for: resolution))
            currentResolution = resolution
            frameQueue.async { [weak self] in
                // A new source is a new picture; do not diff across the switch.
                self?.pendingImage = nil
                self?.pendingHash = nil
                self?.lastKeptHash = nil
            }
            fputs("STATUS: source changed → \(resolution.mode): \(resolution.detail)\n", stderr)
            emitEvent(["event": "source-changed", "mode": resolution.mode, "detail": resolution.detail, "title": resolution.describedTitle])
        } catch let failure as ResolutionFailure {
            // The source stopped being identifiable — a browser window
            // navigated away, or the meeting window closed. Detach rather than
            // keep filming whatever is there now. The timer keeps running, so
            // capture resumes by itself if the meeting comes back.
            fputs("STATUS: source lost (\(failure.reason)); detaching\n", stderr)
            emitEvent(["event": "source-lost", "detail": failure.reason])
            try? await stream.stopCapture()
            self.stream = nil
            currentResolution = nil
            lastUnresolvedReason = failure.reason
        } catch {
            fputs("WARNING: re-resolve failed: \(error.localizedDescription)\n", stderr)
        }
    }

    // MARK: - Stream plumbing

    static func shareableContent() async throws -> SCShareableContent {
        do {
            return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            let nsError = error as NSError
            if nsError.domain == "com.apple.screencapturekit" || nsError.code == -3801 {
                throw ResolutionFailure(reason: "Screen Recording permission denied")
            }
            throw error
        }
    }

    /// Build the content filter.
    ///
    /// One line, one shape, no branches — `desktopIndependentWindow` is the
    /// whole privacy story. It captures that window's own content wherever it
    /// is in the stacking order, so anything in front of it is not merely
    /// cropped out, it was never in the frame.
    static func buildFilter(for resolution: Resolution) -> SCContentFilter {
        SCContentFilter(desktopIndependentWindow: resolution.window)
    }

    private func buildConfiguration(for resolution: Resolution) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.capturesAudio = false
        config.showsCursor = false
        config.queueDepth = 3
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, settings.fps)))
        config.scalesToFit = true

        var width = settings.maxWidth
        var height = Int(Double(settings.maxWidth) * 9.0 / 16.0)
        let window = resolution.window
        if window.frame.width > 0 {
            let aspect = window.frame.height / window.frame.width
            width = min(settings.maxWidth, Int(window.frame.width))
            height = max(240, Int(Double(width) * aspect))
        }
        // ScreenCaptureKit wants even dimensions.
        config.width = width - (width % 2)
        config.height = height - (height % 2)
        return config
    }

    // MARK: - Frame handling

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        // ScreenCaptureKit sends idle/blank/suppressed frames alongside real
        // ones. Encoding those is how a "slide" turns out to be a grey
        // rectangle, so only `.complete` frames are considered.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let attachment = attachments.first,
              let rawStatus = attachment[.status] as? Int,
              let status = SCFrameStatus(rawValue: rawStatus),
              status == .complete else { return }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        guard let reduced = FrameHasher.reduce(pixelBuffer) else { return }

        // A black frame is a window minimised or mid-redraw, not a slide.
        guard reduced.meanLuminance > settings.blankLuminance else { return }

        latestImage = reduced.image
        pendingImage = reduced.image
        pendingHash = reduced.hash
        pendingAtMs = Date().timeIntervalSince1970 * 1000
        scheduleSettle()
    }

    /// (Re)arm the settle timer. Every new frame pushes it out, so it only ever
    /// fires once the window has stopped changing.
    private func scheduleSettle() {
        settleTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: frameQueue)
        timer.schedule(deadline: .now() + .milliseconds(settings.stabilityMs))
        timer.setEventHandler { [weak self] in
            self?.settle()
        }
        timer.resume()
        settleTimer = timer
    }

    /// The window has held still long enough to count as a slide.
    private func settle() {
        settleTimer?.cancel()
        settleTimer = nil

        guard let image = pendingImage, let hash = pendingHash else { return }
        pendingImage = nil
        pendingHash = nil

        if let last = lastKeptHash, FrameHasher.distance(hash, last) < settings.changeThreshold {
            return // the same slide we already have
        }

        persist(image: image, atMs: pendingAtMs)
        lastKeptHash = hash
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("ERROR: slide stream stopped: \(error.localizedDescription)\n", stderr)
        emitEvent(["event": "stream-died", "detail": error.localizedDescription])
        exit(EXIT_STREAM_DIED)
    }

    // MARK: - Output

    private func prepareOutputDirectory() throws {
        let fm = FileManager.default
        try fm.createDirectory(atPath: settings.outputDirectory, withIntermediateDirectories: true)
        let csvPath = (settings.outputDirectory as NSString).appendingPathComponent("slides.csv")
        if !fm.fileExists(atPath: csvPath) {
            try "offset_ms,file,width,height,mode,source\n".write(toFile: csvPath, atomically: true, encoding: .utf8)
        }
        csvHandle = FileHandle(forWritingAtPath: csvPath)
        csvHandle?.seekToEndOfFile()

        if settings.speakerSampleMs > 0 {
            let textPath = (settings.outputDirectory as NSString).appendingPathComponent("screen_text.csv")
            if !fm.fileExists(atPath: textPath) {
                try "offset_ms,mode,text\n".write(toFile: textPath, atomically: true, encoding: .utf8)
            }
            speakerHandle = FileHandle(forWritingAtPath: textPath)
            speakerHandle?.seekToEndOfFile()
        }
    }

    private func persist(image cgImage: CGImage, atMs nowMs: Double) {
        let offsetMs = max(0, Int(nowMs - startEpochMs))
        // The stream is already configured at or below maxWidth, so the frame
        // arrives at its final size and no second scale is needed.
        let scaled = CIImage(cgImage: cgImage)

        let name = String(format: "slide-%03d-%08d.jpg", slideIndex, offsetMs)
        let path = (settings.outputDirectory as NSString).appendingPathComponent(name)

        do {
            try ciContext.writeJPEGRepresentation(
                of: scaled,
                to: URL(fileURLWithPath: path),
                colorSpace: CGColorSpaceCreateDeviceRGB(),
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: settings.jpegQuality]
            )
        } catch {
            fputs("WARNING: could not write \(name): \(error.localizedDescription)\n", stderr)
            return
        }

        let mode = currentResolution?.mode ?? "unknown"
        let source = (currentResolution?.describedTitle ?? "").replacingOccurrences(of: "\"", with: "'")
        let row = "\(offsetMs),\(name),\(Int(scaled.extent.width)),\(Int(scaled.extent.height)),\(mode),\"\(source)\"\n"
        csvHandle?.write(Data(row.utf8))

        slideIndex += 1
        fputs("STATUS: kept \(name) (\(mode))\n", stderr)
        emitEvent(["event": "keyframe", "file": name, "offsetMs": String(offsetMs), "mode": mode])
    }

    /// One-line JSON on stdout, so the parent can record decisions without
    /// parsing prose out of stderr.
    private func emitEvent(_ payload: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }
}
