import Foundation
import CoreMedia

/// Writes raw PCM audio data to a WAV file.
///
/// Handles both interleaved and non-interleaved (planar) Float32 audio
/// from ScreenCaptureKit, converting to interleaved Int16 PCM for WAV output.
///
/// Uses CMBlockBuffer directly (simpler and more reliable than AudioBufferList).
/// For non-interleaved multi-channel audio, the block buffer contains channels
/// concatenated: [ch0 samples][ch1 samples]. We interleave during conversion.
final class WAVWriter {
    private let fileHandle: FileHandle
    private let filePath: String
    private let sampleRate: Int
    private let channels: Int
    private let bitDepth: Int
    private var dataSize: UInt32 = 0
    private var isFinalised = false
    private var formatLogged = false
    private var lastHeaderUpdate: UInt32 = 0
    /// Update the WAV header every ~1 MB of audio data so the file remains
    /// readable even if the process is killed without a clean shutdown.
    private let headerUpdateInterval: UInt32 = 1_048_576

    init(outputPath: String, sampleRate: Int, channels: Int, bitDepth: Int) throws {
        self.filePath = outputPath
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitDepth = bitDepth

        // Create the file
        FileManager.default.createFile(atPath: outputPath, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: outputPath) else {
            throw CaptureError.fileCreationFailed(outputPath)
        }
        self.fileHandle = handle

        // Write placeholder WAV header (44 bytes)
        writeHeader()
    }

    /// Append raw PCM data from a CMSampleBuffer
    func write(buffer: CMSampleBuffer) throws {
        guard !isFinalised else { return }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(buffer) else {
            return
        }

        let length = CMBlockBufferGetDataLength(blockBuffer)
        guard length > 0 else { return }

        // Read raw bytes from block buffer
        var data = Data(count: length)
        let copyStatus = data.withUnsafeMutableBytes { rawBuffer in
            CMBlockBufferCopyDataBytes(
                blockBuffer,
                atOffset: 0,
                dataLength: length,
                destination: rawBuffer.baseAddress!
            )
        }

        guard copyStatus == kCMBlockBufferNoErr else {
            throw CaptureError.bufferCopyFailed
        }

        // Detect audio format from the sample buffer
        let isNonInterleaved: Bool
        let inputChannels: Int
        if let formatDesc = CMSampleBufferGetFormatDescription(buffer),
           let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) {
            let asbd = asbdPtr.pointee
            isNonInterleaved = (asbd.mFormatFlags & kLinearPCMFormatFlagIsNonInterleaved) != 0
            inputChannels = Int(asbd.mChannelsPerFrame)

            if !formatLogged {
                formatLogged = true
                let isFloat = (asbd.mFormatFlags & kLinearPCMFormatFlagIsFloat) != 0
                fputs("STATUS: Input audio format: \(asbd.mSampleRate) Hz, \(inputChannels) ch, \(asbd.mBitsPerChannel) bit, float=\(isFloat), nonInterleaved=\(isNonInterleaved)\n", stderr)
            }
        } else {
            isNonInterleaved = false
            inputChannels = channels
        }

        // Convert Float32 PCM to Int16 PCM
        let float32Count = length / MemoryLayout<Float32>.size
        let int16Data: Data

        if isNonInterleaved && inputChannels > 1 {
            // Non-interleaved (planar): block buffer has [ch0_all_samples][ch1_all_samples]...
            // We need to interleave for WAV: [ch0_s0, ch1_s0, ch0_s1, ch1_s1, ...]
            let framesPerChannel = float32Count / inputChannels

            int16Data = data.withUnsafeBytes { rawBuffer -> Data in
                let floatPtr = rawBuffer.bindMemory(to: Float32.self)
                var result = Data(capacity: framesPerChannel * channels * MemoryLayout<Int16>.size)

                for frame in 0..<framesPerChannel {
                    for ch in 0..<min(inputChannels, channels) {
                        let idx = ch * framesPerChannel + frame
                        let sample = idx < float32Count ? floatPtr[idx] : 0.0
                        let clamped = max(-1.0, min(1.0, sample))
                        let int16Value = Int16(clamped * Float32(Int16.max))
                        withUnsafeBytes(of: int16Value.littleEndian) { result.append(contentsOf: $0) }
                    }
                }

                return result
            }
        } else {
            // Interleaved or mono — direct conversion
            int16Data = data.withUnsafeBytes { rawBuffer -> Data in
                let floatPtr = rawBuffer.bindMemory(to: Float32.self)
                var result = Data(capacity: float32Count * MemoryLayout<Int16>.size)

                for i in 0..<float32Count {
                    let sample = floatPtr[i]
                    let clamped = max(-1.0, min(1.0, sample))
                    let int16Value = Int16(clamped * Float32(Int16.max))
                    withUnsafeBytes(of: int16Value.littleEndian) { result.append(contentsOf: $0) }
                }

                return result
            }
        }

        fileHandle.write(int16Data)
        dataSize += UInt32(int16Data.count)

        // Periodically patch the WAV header so the file stays readable
        // even if the process is killed without calling finalise()
        if dataSize - lastHeaderUpdate >= headerUpdateInterval {
            patchHeader()
            lastHeaderUpdate = dataSize
        }
    }

    /// Finalise the WAV file by patching the header size fields
    func finalise() throws {
        guard !isFinalised else { return }
        isFinalised = true
        patchHeader()
        fileHandle.closeFile()
    }

    /// Patch the RIFF and data chunk size fields in the WAV header
    /// to reflect the current amount of audio data written.
    /// Safe to call repeatedly during recording.
    private func patchHeader() {
        let currentOffset = fileHandle.offsetInFile
        let fileSize = dataSize + 36

        // Patch file size at offset 4
        fileHandle.seek(toFileOffset: 4)
        fileHandle.write(uint32Data(fileSize))

        // Patch data chunk size at offset 40
        fileHandle.seek(toFileOffset: 40)
        fileHandle.write(uint32Data(dataSize))

        // Seek back to end so subsequent writes go to the right place
        fileHandle.seek(toFileOffset: currentOffset)
    }

    // MARK: - Private

    private func writeHeader() {
        var header = Data()

        header.append(contentsOf: "RIFF".utf8)
        header.append(uint32Data(0))
        header.append(contentsOf: "WAVE".utf8)

        header.append(contentsOf: "fmt ".utf8)
        header.append(uint32Data(16))
        header.append(uint16Data(1))                          // PCM
        header.append(uint16Data(UInt16(channels)))
        header.append(uint32Data(UInt32(sampleRate)))
        let byteRate = UInt32(sampleRate * channels * (bitDepth / 8))
        header.append(uint32Data(byteRate))
        let blockAlign = UInt16(channels * (bitDepth / 8))
        header.append(uint16Data(blockAlign))
        header.append(uint16Data(UInt16(bitDepth)))

        header.append(contentsOf: "data".utf8)
        header.append(uint32Data(0))

        fileHandle.write(header)
    }

    private func uint32Data(_ value: UInt32) -> Data {
        var v = value.littleEndian
        return Data(bytes: &v, count: 4)
    }

    private func uint16Data(_ value: UInt16) -> Data {
        var v = value.littleEndian
        return Data(bytes: &v, count: 2)
    }
}
