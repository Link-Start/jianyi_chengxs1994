import { Input, Output, Conversion, BlobSource, BufferTarget, MP4, Mp4OutputFormat, MovOutputFormat } from 'mediabunny';

// 将浏览器录制的 H.264/AAC 数据重新封装为 MP4 或 QuickTime MOV，保留全部音视频轨道。
async function convert(blob, format, signal, onProgress) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  const output = new Output({ format: format === 'mov' ? new MovOutputFormat({ fastStart: 'in-memory' }) : new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  let conversion;
  // 中止封装，避免取消操作后仍生成下载。
  const cancel = () => { conversion?.cancel().catch(() => {}); };
  try {
    signal.throwIfAborted();
    conversion = await Conversion.init({ input, output, showWarnings: false });
    signal.addEventListener('abort', cancel, { once: true });
    signal.throwIfAborted();
    if (!conversion.isValid || conversion.discardedTracks.length) throw new Error('音视频轨道无法完整封装，请换用支持 H.264/AAC 的浏览器');
    conversion.onProgress = onProgress;
    await conversion.execute(); signal.throwIfAborted();
    return new Blob([output.target.buffer], { type: format === 'mov' ? 'video/quicktime' : 'video/mp4' });
  } finally {
    signal.removeEventListener('abort', cancel);
    if (conversion && conversion.state !== 'done') await conversion.cancel();
    input.dispose();
  }
}
window.LightcutMux = { convert };
