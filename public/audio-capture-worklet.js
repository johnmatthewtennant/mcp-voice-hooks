/**
 * AudioWorklet processor for microphone capture.
 *
 * Captures audio at the native AudioContext sample rate (e.g., 48kHz on iOS)
 * and downsamples to 16kHz using nearest-neighbor interpolation, then emits
 * 20ms frames (320 samples = 640 bytes as PCM16) via port.postMessage.
 *
 * Important: iOS Safari ignores requested sampleRate and always uses the
 * hardware rate. The worklet MUST capture at native rate and downsample.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    // sampleRate is the actual AudioContext rate (global in AudioWorklet scope)
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    // Number of native-rate samples needed to produce one 20ms output frame (320 samples)
    this.inputFrameSize = Math.round(320 * this.ratio);
  }

  downsample(buffer, ratio) {
    const outputLength = Math.floor(buffer.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      output[i] = buffer[Math.round(i * ratio)];
    }
    return output;
  }

  process(inputs) {
    const input = inputs[0]?.[0]; // mono channel
    if (!input) return true;

    // Accumulate samples at native rate
    const newBuffer = new Float32Array(this.buffer.length + input.length);
    newBuffer.set(this.buffer);
    newBuffer.set(input, this.buffer.length);
    this.buffer = newBuffer;

    // Emit 20ms frames, downsampled to 16kHz
    while (this.buffer.length >= this.inputFrameSize) {
      const chunk = this.buffer.slice(0, this.inputFrameSize);
      const downsampled = this.ratio === 1 ? chunk : this.downsample(chunk, this.ratio);
      this.port.postMessage({ type: 'audio-frame', frame: downsampled });
      this.buffer = this.buffer.slice(this.inputFrameSize);
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
