import Foundation
import ScreenCaptureKit
import CoreMedia

/// Errors that can occur during audio capture
enum CaptureError: Error, LocalizedError {
    case permissionDenied
    case noDisplayFound
    case streamStartFailed(String)
    case fileCreationFailed(String)
    case bufferCopyFailed
    case alreadyRunning

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Screen Recording permission denied. Grant permission in System Settings > Privacy & Security > Screen Recording."
        case .noDisplayFound:
            return "No display found for audio capture."
        case .streamStartFailed(let reason):
            return "Failed to start audio stream: \(reason)"
        case .fileCreationFailed(let path):
            return "Failed to create output file: \(path)"
        case .bufferCopyFailed:
            return "Failed to copy audio buffer data."
        case .alreadyRunning:
            return "Audio capture is already running."
        }
    }
}

/// Which `SCContentFilter` shape to build.
///
/// The two produce different internal audio paths and have opposite failure
/// modes, so the choice is explicit rather than implied by whichever initialiser
/// happened to be typed. `--filter-shape` exists to A/B them in situ, because
/// which one works has now changed twice. See `buildFilter`.
enum FilterShape: String {
    /// `display:including:apps:` — taps each listed application's audio.
    case including
    /// `display:excludingApplications:` — the display's audio mix. The default.
    case excluding
}

/// Exit code used when the capture dies mid-session.
///
/// This is the whole point of the code: the parent watches `exit` and can only
/// react to a *non-zero* status. A stream that self-terminates and then lets the
/// process idle to `exit 0` is indistinguishable from a healthy recording, which
/// is how a 29-minute meeting was captured as 114 seconds of audio followed by
/// nothing, and reported as complete.
let EXIT_STREAM_DIED: Int32 = 4

/// How often to fold newly-launched applications into the live content filter.
///
/// Four seconds is chosen against what it is racing: a person clicks a meeting
/// link, the app launches, and they start talking. Missing the first few seconds
/// of pleasantries is survivable; missing the meeting is not. Each tick costs one
/// `SCShareableContent` enumeration, and only reinstalls the filter when the
/// application set actually changed.
let FILTER_REFRESH_INTERVAL: DispatchTimeInterval = .seconds(4)

/// Captures system audio using ScreenCaptureKit and writes it to a WAV file.
///
/// Uses SCStream with audio-only configuration (no display capture).
/// Implements SCStreamOutput to receive CMSampleBuffer audio frames.
@available(macOS 13.0, *)
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputPath: String
    private let sampleRate: Int
    private let channels: Int
    private let bitDepth: Int
    private let filterShape: FilterShape

    private var stream: SCStream?
    private var wavWriter: WAVWriter?
    private var isRunning = false

    /// Guards `wavWriter`. Audio arrives on the sample-handler queue while
    /// `stop()` and the stream-death path finalise from other queues; `WAVWriter`
    /// seeks the file handle to patch the header, so an interleaved write would
    /// land audio in the middle of the header.
    private let writerLock = NSLock()

    /// The application set the live filter was built from, as PIDs.
    ///
    /// Kept so each refresh can ask "has anything actually changed?" — rebuilding
    /// and reinstalling an identical filter every few seconds is churn on a live
    /// audio path for no benefit.
    private var capturedPIDs: Set<pid_t> = []
    private var refreshTimer: DispatchSourceTimer?
    private let refreshQueue = DispatchQueue(label: "io.cxnotes.sck.filter-refresh")
    /// Set while a refresh is in flight, so a slow `SCShareableContent` fetch
    /// cannot stack up overlapping updates behind it. Guarded by `refreshLock`
    /// because it is set on the timer queue and cleared from a Task.
    private var isRefreshing = false
    private let refreshLock = NSLock()

    init(outputPath: String, sampleRate: Int = 48000, channels: Int = 2, bitDepth: Int = 16, filterShape: FilterShape = .excluding) {
        self.outputPath = outputPath
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitDepth = bitDepth
        self.filterShape = filterShape
        super.init()
    }

    /// Start capturing system audio
    func start() async throws {
        guard !isRunning else {
            throw CaptureError.alreadyRunning
        }

        fputs("DEBUG: Getting shareable content...\n", stderr)

        // Get shareable content (triggers permission prompt if needed)
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            let nsError = error as NSError
            if nsError.domain == "com.apple.screencapturekit" || nsError.code == -3801 {
                throw CaptureError.permissionDenied
            }
            throw CaptureError.streamStartFailed(error.localizedDescription)
        }

        fputs("DEBUG: Got \(content.displays.count) displays, \(content.windows.count) windows\n", stderr)

        guard let display = content.displays.first else {
            throw CaptureError.noDisplayFound
        }

        let capturedApps = try capturableApplications(from: content)
        let filter = buildFilter(display: display, apps: capturedApps)
        capturedPIDs = Set(capturedApps.map { $0.processID })
        fputs("DEBUG: Using \(filterShape.rawValue) filter, apps=\(capturedApps.count)\n", stderr)

        // Configure stream for audio-only capture
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = sampleRate
        config.channelCount = channels

        // Minimise display capture overhead (we only want audio)
        // Note: SCK requires reasonable display config even for audio-only capture
        config.width = 16
        config.height = 16
        config.minimumFrameInterval = CMTime(value: 1, timescale: 2) // 2 fps minimum

        fputs("DEBUG: Creating WAV writer...\n", stderr)

        // Create WAV writer
        wavWriter = try WAVWriter(outputPath: outputPath, sampleRate: sampleRate, channels: channels, bitDepth: bitDepth)

        fputs("DEBUG: Starting SCStream...\n", stderr)

        // Create and start stream
        // Both audio and screen outputs must be registered for SCK to deliver audio
        let captureStream = SCStream(filter: filter, configuration: config, delegate: self)
        try captureStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .background))
        try captureStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global(qos: .userInitiated))

        // Use completion handler instead of async version to avoid Swift concurrency deadlocks
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            captureStream.startCapture { error in
                if let error = error {
                    continuation.resume(throwing: CaptureError.streamStartFailed(error.localizedDescription))
                } else {
                    continuation.resume()
                }
            }
        }

        self.stream = captureStream
        self.isRunning = true

        startFilterRefresh()

        fputs("STATUS: Recording started\n", stderr)
    }

    // MARK: - Content filter

    /// Everything running that is not us.
    ///
    /// `excludesCurrentProcessAudio` already covers our own output; dropping our
    /// PID from the list keeps the two consistent and the filter honest about
    /// what it is asking for.
    private func capturableApplications(from content: SCShareableContent) throws -> [SCRunningApplication] {
        let ownPid = ProcessInfo.processInfo.processIdentifier
        let apps = content.applications.filter { $0.processID != ownPid }

        guard !apps.isEmpty else {
            throw CaptureError.streamStartFailed("No capturable applications found")
        }
        return apps
    }

    /// Build the content filter.
    ///
    /// `.excluding` — the display's audio mix — is the default, and it is the
    /// default because it is the only one measured to work. Head-to-head on this
    /// machine (2026-08-14, ARK.driver loaded throughout, RME Babyface Pro as
    /// output), peak amplitude over a 440 Hz tone:
    ///
    ///     source running before capture   including 0.000000   excluding 0.014282
    ///     source launched after capture   including 0.000000   excluding 0.014282
    ///     audio starting after capture    including 0.000000   excluding 0.014282
    ///
    /// The installed helper — the same per-app code that recorded the three lost
    /// meetings — measured 0.000000 alongside it, so this is not a regression in
    /// the refresh work below; the per-app tap simply captures nothing here.
    /// That total silence matches the evidence better than a stale app list ever
    /// did: the Aug 13 session was zero-filled across its *entire* duration, not
    /// from the moment a late app joined.
    ///
    /// This reverses the earlier choice, which took `.including` to be the
    /// defence against the Rogue Amoeba ARK/ACE hijack (gotcha #5). ARK is
    /// loaded during the measurements above and `.excluding` is unaffected by
    /// it, which fits gotcha #5's own caveat that ARK being *loaded* looked
    /// necessary but was never sufficient — the one incident actually resolved
    /// was resolved by restarting `coreaudiod`, not by the filter change.
    ///
    /// `.including` is kept reachable via `--filter-shape` because which shape
    /// works has now changed twice, and being able to A/B it against a live
    /// machine in thirty seconds is worth more than the lines it costs. It is
    /// never selected automatically — invariant #1 forbids a silent alternate
    /// path, and this is a diagnostic, not a fallback.
    ///
    /// The cost of `.including` is also structural: its app list is a *snapshot*,
    /// so an application launched after the filter is built is never captured
    /// unless `refreshFilter()` folds it in.
    private func buildFilter(display: SCDisplay, apps: [SCRunningApplication]) -> SCContentFilter {
        switch filterShape {
        case .including:
            return SCContentFilter(display: display, including: apps, exceptingWindows: [])
        case .excluding:
            // Nothing to exclude by name — `excludesCurrentProcessAudio` on the
            // stream configuration already keeps our own output out of the mix.
            return SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        }
    }

    /// Poll for newly-launched applications and fold them into the live filter.
    ///
    /// Only the `.including` shape needs this, so on the shipped `.excluding`
    /// default this never runs — see `buildFilter`. It is kept because the
    /// snapshot defect it fixes would bite immediately if that default is ever
    /// flipped back, and flipping it is a one-flag change.
    private func startFilterRefresh() {
        guard filterShape == .including else { return }

        let timer = DispatchSource.makeTimerSource(queue: refreshQueue)
        timer.schedule(deadline: .now() + FILTER_REFRESH_INTERVAL, repeating: FILTER_REFRESH_INTERVAL)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.isRunning else { return }
            // Claimed under a lock rather than a bare Bool: the flag is set on
            // this timer's queue and cleared from the Task's context, which is a
            // plain data race on a Bool if left unguarded.
            guard self.beginRefreshIfIdle() else { return }
            Task { [weak self] in
                await self?.refreshFilter()
                self?.endRefresh()
            }
        }
        timer.resume()
        refreshTimer = timer
    }

    /// Claim the refresh slot, or report that one is already in flight.
    ///
    /// Guards against a slow `SCShareableContent` fetch stacking overlapping
    /// updates behind it on a live audio path.
    private func beginRefreshIfIdle() -> Bool {
        refreshLock.lock()
        defer { refreshLock.unlock() }

        if isRefreshing { return false }
        isRefreshing = true
        return true
    }

    private func endRefresh() {
        refreshLock.lock()
        defer { refreshLock.unlock() }
        isRefreshing = false
    }

    private func stopFilterRefresh() {
        refreshTimer?.cancel()
        refreshTimer = nil
    }

    /// Re-enumerate applications and reinstall the filter if the set changed.
    ///
    /// Every failure here is a WARNING, never fatal: the running stream already
    /// has a working filter, and losing the apps that launched in the last few
    /// seconds is enormously better than tearing down a live capture. A failed
    /// update deliberately leaves `capturedPIDs` alone so the next tick retries.
    private func refreshFilter() async {
        guard isRunning, let stream = stream else { return }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            fputs("WARNING: Filter refresh could not read shareable content: \(error.localizedDescription)\n", stderr)
            return
        }

        guard let display = content.displays.first else {
            fputs("WARNING: Filter refresh found no display\n", stderr)
            return
        }

        let apps: [SCRunningApplication]
        do {
            apps = try capturableApplications(from: content)
        } catch {
            return  // Nothing capturable this tick; the existing filter stands.
        }

        let pids = Set(apps.map { $0.processID })
        guard pids != capturedPIDs else { return }

        let added = pids.subtracting(capturedPIDs).count
        let removed = capturedPIDs.subtracting(pids).count

        do {
            try await stream.updateContentFilter(buildFilter(display: display, apps: apps))
            capturedPIDs = pids
            fputs("STATUS: Filter refreshed (+\(added) -\(removed), now \(apps.count) apps)\n", stderr)
        } catch {
            fputs("WARNING: Filter update failed, keeping the previous filter: \(error.localizedDescription)\n", stderr)
        }
    }

    /// Stop capturing and finalise the WAV file
    func stop() async throws {
        guard isRunning, let stream = stream else { return }

        isRunning = false
        stopFilterRefresh()

        do {
            try await stream.stopCapture()
        } catch {
            fputs("WARNING: Error stopping stream: \(error.localizedDescription)\n", stderr)
        }

        try finaliseWriter()

        self.stream = nil

        fputs("STATUS: Recording stopped\n", stderr)
    }

    /// Close out the WAV file exactly once, under the lock.
    ///
    /// Both the ordinary stop and the stream-death path land here, from
    /// different queues, while audio may still be arriving on a third.
    private func finaliseWriter() throws {
        writerLock.lock()
        defer { writerLock.unlock() }

        try wavWriter?.finalise()
        wavWriter = nil
    }

    // MARK: - SCStreamDelegate

    /// The stream died on its own — exit LOUDLY.
    ///
    /// SCStream self-terminates on things that have nothing to do with us, most
    /// notably a display reconfiguration (plugging in a monitor, a display
    /// sleeping, resolution changes on a multi-display Mac). The old handler
    /// logged, set `isRunning = false`, and let the process sit there until the
    /// parent stopped it — at which point it exited 0 and the recording was
    /// filed as complete, having captured only the audio from before the stream
    /// died. That is a 29-minute meeting saved as 114 seconds, with a green tick.
    ///
    /// So: finalise the file first (the audio up to this moment is real and
    /// worth keeping, and an unfinalised header reads as zero-length), then exit
    /// non-zero. The parent already watches the exit code and can restart the
    /// capture from there.
    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        fputs("ERROR: SCStream stopped with error: \(error.localizedDescription)\n", stderr)

        isRunning = false
        stopFilterRefresh()

        do {
            try finaliseWriter()
        } catch {
            fputs("ERROR: Failed to finalise WAV after stream death: \(error.localizedDescription)\n", stderr)
        }

        exit(EXIT_STREAM_DIED)
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if !isRunning {
            return
        }

        if type != .audio {
            return
        }

        writerLock.lock()
        defer { writerLock.unlock() }

        // `isRunning` was read before the lock, so a stop may have completed
        // while we waited for it — in which case the writer is gone and there is
        // nothing to write to.
        guard let writer = wavWriter else { return }

        do {
            try writer.write(buffer: sampleBuffer)
        } catch {
            fputs("ERROR: Failed to write audio buffer: \(error.localizedDescription)\n", stderr)
        }
    }
}
