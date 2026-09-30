import Foundation
import CoreAudio

// call-audio-tap — records the remote party of iPhone-handoff and FaceTime
// calls, which ScreenCaptureKit cannot hear (T206, gotcha #24).
//
//   call-audio-tap <session-dir> [--poll-ms 250]
//       Watch the call daemon for the life of a recording. While — and only
//       while — it plays audio, tap it into call.N.wav. Every finished segment
//       is recorded in call.json. SIGTERM finishes the open segment and exits 0.
//
//   call-audio-tap <session-dir> --target-pid N
//       DIAGNOSTIC ONLY — never passed by the app. Watch process N instead of
//       the call daemon, so the recording path can be exercised with `afplay`
//       when no call is available.
//
//   call-audio-tap --request-access
//       Start and stop one tap so macOS asks for System Audio Recording now,
//       outside any meeting. The first-ever tap blocks ~1 minute on that prompt.
//
// Stdout carries one JSON event per line; stderr is for humans.
//
// Exit codes: 0 clean stop · 64 bad arguments · 69 macOS older than 14.2.

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var object = fields
    object["event"] = event
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

func log(_ message: String) {
    FileHandle.standardError.write("[call-audio-tap] \(message)\n".data(using: .utf8)!)
}

func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

let arguments = CommandLine.arguments

// MARK: - --request-access

@available(macOS 14.2, *)
func runRequestAccess() -> Never {
    // The daemon is listed even when idle, so a tap on it can be built with no
    // call running. It captures silence, which is all we need: the prompt fires
    // when the aggregate starts, and AudioDeviceStart blocks until it is answered.
    guard let target = CoreAudioProcesses.callDaemon() else {
        emit("access-unknown", ["detail": "avconferenced is not listed by Core Audio"])
        exit(0)
    }
    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("cxnotes-call-access-\(getpid())")
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
        let tap = try CallTap(target: target, index: 0, directory: directory)
        Thread.sleep(forTimeInterval: 0.5)
        let record = tap.stop(reason: "access-check")
        emit("access-requested", ["frames": record.frames])
    } catch {
        emit("error", ["detail": error.localizedDescription])
    }
    try? FileManager.default.removeItem(at: directory)
    exit(0)
}

// MARK: - watch mode

/// Everything below runs on the main queue.
@available(macOS 14.2, *)
final class CallWatcher {
    /// A tap that has delivered nothing but exact zeros for this long, during a
    /// call, is almost certainly a missing grant — it looks exactly like this.
    static let silentTapWarningFrames = 20

    let directory: URL
    let targetPid: pid_t?
    var target: AudioObjectID?
    var tap: CallTap?
    var records: [CallTap.Record] = []
    var nextIndex = 1
    /// A tap that failed to start is not retried until the call ends: a
    /// failure every 250 ms would only fill the log.
    var failedThisCall = false
    var silentWarned = false
    var lastRateCheckMs: Int64 = 0
    var tapStartedMs: Int64 = 0

    init(directory: URL, targetPid: pid_t?) {
        self.directory = directory
        self.targetPid = targetPid
    }

    func tick() {
        if target == nil {
            target = targetPid.flatMap(CoreAudioProcesses.processObject(for:)) ?? (targetPid == nil ? CoreAudioProcesses.callDaemon() : nil)
        }
        guard let current = target else { return }

        guard let playing = CoreAudioProcesses.isRunningOutput(current) else {
            // Stale object (the daemon restarted). Close out and re-resolve.
            if tap != nil { finishSegment(reason: "daemon-lost") }
            target = nil
            return
        }

        if playing {
            if tap == nil && !failedThisCall { startSegment(on: current) }
            if tap != nil { watchSegment(on: current) }
        } else {
            failedThisCall = false
            if tap != nil { finishSegment(reason: "call-ended") }
        }
    }

    func startSegment(on target: AudioObjectID) {
        do {
            let started = try CallTap(target: target, index: nextIndex, directory: directory)
            tap = started
            tapStartedMs = nowMs()
            lastRateCheckMs = tapStartedMs
            silentWarned = false
            emit("segment-start", ["index": nextIndex, "file": "call.\(nextIndex).wav", "rate": started.reportedRate])
            log("call audio started → call.\(nextIndex).wav at \(started.reportedRate) Hz")
            nextIndex += 1
        } catch {
            failedThisCall = true
            emit("error", ["detail": error.localizedDescription])
            log("could not start the call tap: \(error.localizedDescription)")
        }
    }

    func watchSegment(on target: AudioObjectID) {
        guard let tap else { return }
        let now = nowMs()
        guard now - lastRateCheckMs >= 1000 else { return }
        lastRateCheckMs = now

        // A rate change mid-call closes the file and opens a new one, so every
        // segment is a single rate.
        if let rate = tap.currentNominalRate, rate != tap.reportedRate {
            log("call audio rate changed \(tap.reportedRate) → \(rate) Hz — new segment")
            finishSegment(reason: "rate-changed")
            startSegment(on: target)
            return
        }

        if !silentWarned, now - tapStartedMs >= Int64(Self.silentTapWarningFrames) * 1000 {
            let progress = tap.progress
            if progress.frames > 0 && progress.peak == 0 {
                silentWarned = true
                emit("silent-tap", ["index": tap.index])
                log("the call tap has delivered only silence for \(Self.silentTapWarningFrames)s — System Audio Recording is probably not granted")
            }
        }
    }

    func finishSegment(reason: String) {
        guard let current = tap else { return }
        tap = nil
        let record = current.stop(reason: reason)
        records.append(record)
        writeManifest()
        emit("segment-end", [
            "index": record.index, "file": record.file, "frames": record.frames,
            "peak": record.peak, "rate": record.sampleRate, "reason": reason
        ])
        log("call audio segment \(record.index) ended (\(reason)): \(record.frames) frames, peak \(record.peak)")
    }

    /// `call.json` is the record of truth the app reads at stop — events
    /// describe intent, this describes what landed on disk.
    func writeManifest() {
        let segments: [[String: Any]] = records.map {
            [
                "index": $0.index, "file": $0.file, "sampleRate": $0.sampleRate,
                "startEpochMs": $0.startEpochMs, "endEpochMs": $0.endEpochMs,
                "frames": $0.frames, "peak": $0.peak, "endReason": $0.endReason
            ]
        }
        let object: [String: Any] = ["version": 1, "segments": segments]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return }
        let url = directory.appendingPathComponent("call.json")
        let temporary = directory.appendingPathComponent("call.json.tmp")
        do {
            try data.write(to: temporary)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
        } catch {
            try? data.write(to: url)
        }
    }

    func shutdown() {
        finishSegment(reason: "recording-stopped")
    }
}

/// Kept alive for the life of the process; dispatch sources are cancelled
/// when released.
var retained: [AnyObject] = []

@available(macOS 14.2, *)
func runWatch(directory: URL, pollMs: Int, targetPid: pid_t?) -> Never {
    let watcher = CallWatcher(directory: directory, targetPid: targetPid)
    retained.append(watcher)

    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    for sig in [SIGTERM, SIGINT] {
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
            watcher.shutdown()
            emit("stopped", ["segments": watcher.records.count])
            exit(0)
        }
        source.resume()
        retained.append(source)
    }

    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: .milliseconds(pollMs))
    timer.setEventHandler { watcher.tick() }
    timer.resume()
    retained.append(timer)

    emit("ready", ["pollMs": pollMs, "daemonListed": CoreAudioProcesses.callDaemon() != nil])
    dispatchMain()
}

// MARK: - entry

if #available(macOS 14.2, *) {
    if arguments.contains("--request-access") { runRequestAccess() }

    guard arguments.count >= 2, !arguments[1].hasPrefix("--") else {
        log("usage: call-audio-tap <session-dir> [--poll-ms N] | --request-access")
        exit(64)
    }

    var pollMs = 250
    if let i = arguments.firstIndex(of: "--poll-ms"), i + 1 < arguments.count,
       let value = Int(arguments[i + 1]), value >= 50 {
        pollMs = value
    }
    var targetPid: pid_t?
    if let i = arguments.firstIndex(of: "--target-pid"), i + 1 < arguments.count {
        targetPid = pid_t(arguments[i + 1])
    }
    runWatch(directory: URL(fileURLWithPath: arguments[1]), pollMs: pollMs, targetPid: targetPid)
} else {
    emit("unavailable", ["detail": "Core Audio process taps need macOS 14.2 or later"])
    exit(69)
}
