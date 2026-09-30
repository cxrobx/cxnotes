import Foundation
import ScreenCaptureKit

/// sck-slide-capture — scoped slide keyframe capture
///
/// Usage:
///   sck-slide-capture <output-dir> [--source-pid N] [--source-bundle ID]
///                     [--fps 2] [--max-width 1440] [--stability-ms 2000]
///                     [--start-epoch-ms N] [--probe] [--check]
///
/// Captures still keyframes of the ONE window the meeting audio belongs to.
/// Never captures the display. Exits 3 when no source can be resolved, which is
/// a deliberate outcome rather than a failure — see EXIT_UNRESOLVED.
///
/// `--probe` resolves a source, prints the decision as JSON, and exits without
/// capturing anything. It is the way to check what WOULD be captured.

@available(macOS 13.0, *)
func run() async {
    let args = CommandLine.arguments

    if args.contains("--check") {
        do {
            _ = try await SlideCapture.shareableContent()
            fputs("STATUS: ScreenCaptureKit available and permitted\n", stderr)
            exit(0)
        } catch {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            exit(2)
        }
    }

    let isProbe = args.contains("--probe")
    let isList = args.contains("--list-windows")
    let isOCR = args.contains("--ocr")

    guard args.count >= 2, !args[1].hasPrefix("--") || isProbe || isList || isOCR else {
        fputs("Usage: sck-slide-capture <output-dir> [--source-pid N] [--source-bundle ID] [--probe]\n", stderr)
        exit(1)
    }

    var settings = SlideCaptureSettings(outputDirectory: args[1].hasPrefix("--") ? "" : args[1])
    var sourcePID: pid_t?
    var sourceBundle: String?
    var windowTitle: String?

    var i = args[1].hasPrefix("--") ? 1 : 2
    while i < args.count {
        switch args[i] {
        case "--source-pid":
            if i + 1 < args.count, let value = Int32(args[i + 1]) { sourcePID = value; i += 2 }
            else { fputs("ERROR: Invalid --source-pid\n", stderr); exit(1) }
        case "--source-bundle":
            if i + 1 < args.count { sourceBundle = args[i + 1]; i += 2 }
            else { fputs("ERROR: Invalid --source-bundle\n", stderr); exit(1) }
        case "--fps":
            if i + 1 < args.count, let value = Int(args[i + 1]) { settings.fps = value; i += 2 }
            else { fputs("ERROR: Invalid --fps\n", stderr); exit(1) }
        case "--max-width":
            if i + 1 < args.count, let value = Int(args[i + 1]) { settings.maxWidth = value; i += 2 }
            else { fputs("ERROR: Invalid --max-width\n", stderr); exit(1) }
        case "--stability-ms":
            if i + 1 < args.count, let value = Int(args[i + 1]) { settings.stabilityMs = value; i += 2 }
            else { fputs("ERROR: Invalid --stability-ms\n", stderr); exit(1) }
        case "--speaker-sample-ms":
            if i + 1 < args.count, let value = Int(args[i + 1]) { settings.speakerSampleMs = value; i += 2 }
            else { fputs("ERROR: Invalid --speaker-sample-ms\n", stderr); exit(1) }
        case "--change-threshold":
            if i + 1 < args.count, let value = Int(args[i + 1]) { settings.changeThreshold = value; i += 2 }
            else { fputs("ERROR: Invalid --change-threshold\n", stderr); exit(1) }
        case "--start-epoch-ms":
            if i + 1 < args.count, let value = Double(args[i + 1]) { settings.startEpochMs = value; i += 2 }
            else { fputs("ERROR: Invalid --start-epoch-ms\n", stderr); exit(1) }
        case "--window-title":
            if i + 1 < args.count { windowTitle = args[i + 1]; i += 2 }
            else { fputs("ERROR: Invalid --window-title\n", stderr); exit(1) }
        case "--list-windows":
            i += 1
        case "--ocr":
            i += 2  // handled before parsing; skip its directory argument
        case "--probe":
            i += 1
        default:
            fputs("WARNING: Unknown argument: \(args[i])\n", stderr)
            i += 1
        }
    }

    if args.contains("--list-windows") {
        await listWindows()
        return
    }

    if let ocrIndex = args.firstIndex(of: "--ocr") {
        guard ocrIndex + 1 < args.count else {
            fputs("ERROR: --ocr needs a slides directory\n", stderr)
            exit(1)
        }
        runOCR(directory: args[ocrIndex + 1])
        return
    }

    var resolver = SourceResolver(sourcePID: sourcePID, sourceBundleID: sourceBundle)
    resolver.windowTitleOverride = windowTitle

    if isProbe {
        await probe(resolver: resolver)
        return
    }

    guard !settings.outputDirectory.isEmpty else {
        fputs("ERROR: output directory is required unless --probe is given\n", stderr)
        exit(1)
    }

    let capture = SlideCapture(settings: settings, resolver: resolver)

    let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let stopHandler = {
        fputs("STATUS: Signal received, stopping slide capture...\n", stderr)
        sigTermSource.cancel()
        sigIntSource.cancel()
        Task {
            await capture.stop()
            exit(0)
        }
    }
    sigTermSource.setEventHandler(handler: stopHandler)
    sigIntSource.setEventHandler(handler: stopHandler)
    sigTermSource.resume()
    sigIntSource.resume()

    do {
        // Never throws for an unresolvable source — that is a waiting state,
        // reported as an event, not a failure. Only real errors surface here.
        try await capture.start()
    } catch {
        fputs("ERROR: \(error.localizedDescription)\n", stderr)
        exit(1)
    }

    fputs("STATUS: Slide capture running. Send SIGTERM or SIGINT to stop.\n", stderr)
}

/// OCR a finished slides directory and print one JSON object per keyframe.
///
/// A separate INVOCATION rather than work done during capture: reading text is
/// processing, it belongs with transcription, and doing it live would put Vision
/// on the same clock as a meeting for no benefit.
@available(macOS 13.0, *)
func runOCR(directory: String) {
    do {
        let results = try SlideOCR.run(directory: directory)
        let payload = results.map { result -> [String: Any] in
            ["file": result.file, "offsetMs": result.offsetMs, "text": result.text, "lines": result.lines]
        }
        let data = try JSONSerialization.data(withJSONObject: ["slides": payload], options: [.sortedKeys])
        print(String(data: data, encoding: .utf8) ?? "{\"slides\":[]}")
        fflush(stdout)
        exit(0)
    } catch let failure as ResolutionFailure {
        fputs("ERROR: \(failure.reason)\n", stderr)
        exit(1)
    } catch {
        fputs("ERROR: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

/// Print every on-screen window, so a source decision can be checked against
/// what the OS actually sees rather than against what we assume it sees.
@available(macOS 13.0, *)
func listWindows() async {
    guard let content = try? await SlideCapture.shareableContent() else {
        fputs("ERROR: could not enumerate windows\n", stderr)
        exit(1)
    }
    for window in content.windows where window.isOnScreen {
        guard let title = window.title, !title.isEmpty else { continue }
        let owner = window.owningApplication?.applicationName ?? "?"
        let bundle = window.owningApplication?.bundleIdentifier ?? "?"
        let size = "\(Int(window.frame.width))x\(Int(window.frame.height))"
        print("\(window.windowID)\t\(size)\t\(owner) [\(bundle)]\t\(title)")
    }
    exit(0)
}

/// Resolve and report without capturing.
@available(macOS 13.0, *)
func probe(resolver: SourceResolver) async {
    do {
        let content = try await SlideCapture.shareableContent()
        let (resolution, _) = try resolver.resolve(content: content, lockedShareWindowID: nil)
        printJSON([
            "event": "probe",
            "resolved": "true",
            "mode": resolution.mode,
            "title": resolution.describedTitle,
            "detail": resolution.detail,
            "windowId": String(resolution.windowID)
        ])
        exit(0)
    } catch let failure as ResolutionFailure {
        printJSON(["event": "probe", "resolved": "false", "detail": failure.reason])
        exit(EXIT_UNRESOLVED)
    } catch {
        printJSON(["event": "probe", "resolved": "false", "detail": error.localizedDescription])
        exit(1)
    }
}

func printJSON(_ payload: [String: String]) {
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

if #available(macOS 13.0, *) {
    Task { await run() }
    dispatchMain()
} else {
    fputs("ERROR: ScreenCaptureKit requires macOS 13.0 or later\n", stderr)
    exit(1)
}
