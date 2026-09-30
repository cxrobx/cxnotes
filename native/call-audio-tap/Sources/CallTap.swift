import Foundation
import CoreAudio
import AudioToolbox

/// One tap on the call daemon, recording one segment to disk.
///
/// Shape copied from Meeting Copilot's `SystemAudioTap` (its gotcha #20), with
/// its landmines kept:
/// - **Tap-only aggregate.** An aggregate that also lists the output device
///   picks up that device's INPUT streams (a headset mic), which would put the
///   user's own voice on the other side's track.
/// - **`.unmuted` only.** `.mutedWhenTapped` on `avconferenced` mutes the call
///   itself and makes the remote party hear themselves.
/// - **Private.** The aggregate never appears in the user's Sound settings.
///
/// Unlike Meeting Copilot this taps ONE process, not the whole system: the
/// whole point is that nothing but the call daemon can ever land here, so a
/// Meet or Zoom recording has nothing to mix even if this were running.
@available(macOS 14.2, *)
final class CallTap {
    struct Record {
        let index: Int
        let file: String
        let sampleRate: Int
        let startEpochMs: Int64
        let endEpochMs: Int64
        let frames: Int
        let peak: Int
        let endReason: String
    }

    let index: Int
    private let writer: WavWriter
    private let ioQueue = DispatchQueue(label: "cxnotes.call-audio-tap.io", qos: .userInteractive)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?

    // Touched only on ioQueue.
    private var firstBufferEpochMs: Int64 = 0
    private var lastBufferEpochMs: Int64 = 0
    private var peak: Float = 0
    private var scratch = [Float]()

    let reportedRate: Int

    /// Build and start the tap. Throws with the failing step named; on a throw
    /// everything created so far has already been torn down.
    init(target: AudioObjectID, index: Int, directory: URL) throws {
        self.index = index

        let description = CATapDescription(monoMixdownOfProcesses: [target])
        description.name = "CXNotes call audio"
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        try Self.check(AudioHardwareCreateProcessTap(description, &tap), "create process tap")

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "CXNotes call audio",
            kAudioAggregateDeviceUIDKey: "com.christopherrobinson.cxnotes.call-tap.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        var aggregateDevice = AudioObjectID(kAudioObjectUnknown)
        let aggregateStatus = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateDevice)
        if aggregateStatus != noErr {
            AudioHardwareDestroyProcessTap(tap)
            throw Self.failure("create aggregate device", aggregateStatus)
        }

        let rate = Self.nominalRate(of: aggregateDevice) ?? 48000
        let file = directory.appendingPathComponent("call.\(index).wav")
        let writer: WavWriter
        do {
            writer = try WavWriter(url: file, sampleRate: rate)
        } catch {
            AudioHardwareDestroyAggregateDevice(aggregateDevice)
            AudioHardwareDestroyProcessTap(tap)
            throw error
        }

        self.tapID = tap
        self.aggregateID = aggregateDevice
        self.writer = writer
        self.reportedRate = rate

        var proc: AudioDeviceIOProcID?
        let procStatus = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateDevice, ioQueue) { [weak self] _, input, _, _, _ in
            self?.ingest(input)
        }
        if procStatus != noErr {
            teardown()
            throw Self.failure("create IOProc", procStatus)
        }
        self.procID = proc

        let startStatus = AudioDeviceStart(aggregateDevice, proc)
        if startStatus != noErr {
            teardown()
            throw Self.failure("start aggregate device", startStatus)
        }
    }

    /// The aggregate's current nominal rate, re-read by the watcher once a
    /// second: AirPods drop to a call rate without the default device changing,
    /// and a segment must never mix two rates in one file.
    var currentNominalRate: Int? { Self.nominalRate(of: aggregateID) }

    /// Frames written and peak so far (Int16 scale), read off the IO queue.
    var progress: (frames: Int, peak: Int) {
        ioQueue.sync { (writer.frames, Int(peak * 32767)) }
    }

    func stop(reason: String) -> Record {
        teardown()
        return ioQueue.sync {
            writer.close()
            return Record(
                index: index,
                file: writer.url.lastPathComponent,
                sampleRate: reportedRate,
                startEpochMs: firstBufferEpochMs,
                endEpochMs: lastBufferEpochMs,
                frames: writer.frames,
                peak: Int(peak * 32767),
                endReason: reason
            )
        }
    }

    private func teardown() {
        if let procID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            self.procID = nil
        }
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    /// Runs on ioQueue.
    private func ingest(_ input: UnsafePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        // Tap-only aggregate ⇒ one input stream; `last` stays right even if a
        // subdevice ever appeared, because taps follow subdevices.
        guard let buffer = buffers.last, let data = buffer.mData else { return }
        let channels = Int(max(buffer.mNumberChannels, 1))
        let frames = Int(buffer.mDataByteSize) / (MemoryLayout<Float>.size * channels)
        guard frames > 0 else { return }

        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if firstBufferEpochMs == 0 {
            // The buffer's first sample was captured one buffer-length ago.
            firstBufferEpochMs = now - Int64(Double(frames) / Double(reportedRate) * 1000)
        }
        lastBufferEpochMs = now

        let source = data.assumingMemoryBound(to: Float.self)
        if scratch.count < frames { scratch = [Float](repeating: 0, count: frames) }
        for frame in 0..<frames {
            var sum: Float = 0
            for channel in 0..<channels { sum += source[frame * channels + channel] }
            let sample = sum / Float(channels)
            scratch[frame] = sample
            peak = max(peak, abs(sample))
        }
        scratch.withUnsafeBufferPointer { writer.append($0.baseAddress!, count: frames) }
    }

    private static func nominalRate(of device: AudioObjectID) -> Int? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &rate) == noErr, rate > 0 else { return nil }
        return Int(rate)
    }

    private static func check(_ status: OSStatus, _ step: String) throws {
        guard status == noErr else { throw failure(step, status) }
    }

    static func failure(_ step: String, _ status: OSStatus) -> NSError {
        NSError(domain: "CallTap", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "\(step) failed (OSStatus \(status))"])
    }
}
