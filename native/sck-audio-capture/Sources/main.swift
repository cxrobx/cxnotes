import Foundation
import ScreenCaptureKit

/// sck-audio-capture — ScreenCaptureKit system audio capture CLI
///
/// Usage: sck-audio-capture <output-path> [--sample-rate 48000] [--channels 2] [--bit-depth 16] [--check]
///
/// Captures system audio to a WAV file using Apple's ScreenCaptureKit.
/// Send SIGTERM or SIGINT to stop recording gracefully.
/// Status messages are written to stderr.
/// Exit codes: 0 = success, 1 = error, 2 = permission denied,
///             4 = the capture stream died mid-session (see EXIT_STREAM_DIED)

@available(macOS 13.0, *)
func run() async {
    let args = CommandLine.arguments

    // Handle --check flag (permission/availability test)
    if args.contains("--check") {
        do {
            _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            fputs("STATUS: ScreenCaptureKit available and permitted\n", stderr)
            exit(0)
        } catch {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            exit(2)
        }
    }

    // Parse arguments
    guard args.count >= 2 else {
        fputs("Usage: sck-audio-capture <output-path> [--sample-rate 48000] [--channels 2] [--bit-depth 16] [--check]\n", stderr)
        exit(1)
    }

    let outputPath = args[1]
    var sampleRate = 48000
    var channels = 2
    var bitDepth = 16
    var filterShape = FilterShape.excluding

    // Simple argument parsing
    var i = 2
    while i < args.count {
        switch args[i] {
        case "--sample-rate":
            if i + 1 < args.count, let value = Int(args[i + 1]) {
                sampleRate = value
                i += 2
            } else {
                fputs("ERROR: Invalid --sample-rate value\n", stderr)
                exit(1)
            }
        case "--channels":
            if i + 1 < args.count, let value = Int(args[i + 1]) {
                channels = value
                i += 2
            } else {
                fputs("ERROR: Invalid --channels value\n", stderr)
                exit(1)
            }
        case "--bit-depth":
            if i + 1 < args.count, let value = Int(args[i + 1]) {
                bitDepth = value
                i += 2
            } else {
                fputs("ERROR: Invalid --bit-depth value\n", stderr)
                exit(1)
            }
        case "--filter-shape":
            // Diagnostic only: lets a harness compare the per-app tap against
            // the display-mix shape on the same build (gotcha #5).
            if i + 1 < args.count, let value = FilterShape(rawValue: args[i + 1]) {
                filterShape = value
                i += 2
            } else {
                fputs("ERROR: --filter-shape must be 'including' or 'excluding'\n", stderr)
                exit(1)
            }
        default:
            fputs("WARNING: Unknown argument: \(args[i])\n", stderr)
            i += 1
        }
    }

    fputs("STATUS: Initialising capture (sample rate: \(sampleRate), channels: \(channels), bit depth: \(bitDepth))\n", stderr)
    fputs("STATUS: Output: \(outputPath)\n", stderr)

    let capture = SystemAudioCapture(
        outputPath: outputPath,
        sampleRate: sampleRate,
        channels: channels,
        bitDepth: bitDepth,
        filterShape: filterShape
    )

    // Set up signal handling for graceful shutdown using DispatchSource
    let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)

    // Ignore default signal handling
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let stopHandler = {
        fputs("STATUS: Signal received, stopping capture...\n", stderr)
        sigTermSource.cancel()
        sigIntSource.cancel()
        Task {
            do {
                try await capture.stop()
            } catch {
                fputs("ERROR: Failed to stop capture: \(error.localizedDescription)\n", stderr)
            }
            exit(0)
        }
    }

    sigTermSource.setEventHandler(handler: stopHandler)
    sigIntSource.setEventHandler(handler: stopHandler)
    sigTermSource.resume()
    sigIntSource.resume()

    // Start capture
    do {
        try await capture.start()
    } catch {
        let exitCode: Int32
        if let captureError = error as? CaptureError {
            fputs("ERROR: \(captureError.localizedDescription)\n", stderr)
            switch captureError {
            case .permissionDenied:
                exitCode = 2
            default:
                exitCode = 1
            }
        } else {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            exitCode = 1
        }
        exit(exitCode)
    }

    // Keep alive — signal handlers will trigger stop
    fputs("STATUS: Capturing system audio. Send SIGTERM or SIGINT to stop.\n", stderr)
}

// Entry point — use dispatchMain() instead of RunLoop.main.run()
// to avoid deadlocking Swift concurrency continuations that need the main thread
if #available(macOS 13.0, *) {
    Task {
        await run()
    }
    dispatchMain()
} else {
    fputs("ERROR: ScreenCaptureKit requires macOS 13.0 or later\n", stderr)
    exit(1)
}
