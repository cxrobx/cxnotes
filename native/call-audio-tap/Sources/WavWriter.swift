import Foundation

/// 16-bit mono PCM WAV, written at whatever rate the tap delivers.
///
/// The header's two size fields stay ZERO until `close()`. That is deliberate:
/// `repairWavHeader` in `utils/audioProcessing.js` only repairs a header whose
/// sizes are both zero, so a helper killed with SIGKILL leaves a file the app
/// can still fix. Patching the sizes periodically would leave stale non-zero
/// values that the repair then refuses to touch.
///
/// Resampling to 16 kHz happens later, in sox, at mix time. Keeping the native
/// rate here means a wrong rate can be corrected afterwards from the measured
/// frame count, which a file already resampled from the wrong rate cannot.
final class WavWriter {
    let url: URL
    let sampleRate: Int
    private let handle: FileHandle
    private(set) var frames = 0
    private var closed = false

    init(url: URL, sampleRate: Int) throws {
        self.url = url
        self.sampleRate = sampleRate
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: url.path) else {
            throw NSError(domain: "WavWriter", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot open \(url.path)"])
        }
        self.handle = handle
        handle.write(Self.header(sampleRate: sampleRate, dataBytes: 0, placeholder: true))
    }

    /// Append Float32 samples in [-1, 1] as Int16.
    func append(_ samples: UnsafePointer<Float>, count: Int) {
        guard !closed, count > 0 else { return }
        var data = Data(count: count * 2)
        data.withUnsafeMutableBytes { raw in
            let out = raw.bindMemory(to: Int16.self)
            for i in 0..<count {
                let clamped = max(-1.0, min(1.0, samples[i]))
                out[i] = Int16(clamped * 32767).littleEndian
            }
        }
        handle.write(data)
        frames += count
    }

    func close() {
        guard !closed else { return }
        closed = true
        let dataBytes = frames * 2
        handle.seek(toFileOffset: 0)
        handle.write(Self.header(sampleRate: sampleRate, dataBytes: dataBytes, placeholder: false))
        handle.closeFile()
    }

    static func header(sampleRate: Int, dataBytes: Int, placeholder: Bool) -> Data {
        var data = Data()
        func u32(_ v: UInt32) { var le = v.littleEndian; data.append(Data(bytes: &le, count: 4)) }
        func u16(_ v: UInt16) { var le = v.littleEndian; data.append(Data(bytes: &le, count: 2)) }
        data.append("RIFF".data(using: .ascii)!)
        u32(placeholder ? 0 : UInt32(36 + dataBytes))
        data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!)
        u32(16)
        u16(1)                       // PCM
        u16(1)                       // mono
        u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 2))  // byte rate
        u16(2)                       // block align
        u16(16)                      // bits per sample
        data.append("data".data(using: .ascii)!)
        u32(placeholder ? 0 : UInt32(dataBytes))
        return data
    }
}
