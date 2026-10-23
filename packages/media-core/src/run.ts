import { spawn } from 'node:child_process';

export class FfmpegError extends Error {
  override readonly name = 'FfmpegError';
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
  }
}

export type MediaToolsOptions = {
  /** Defaults to env FFMPEG_PATH or "ffmpeg". */
  ffmpegPath?: string;
  /** Defaults to env FFPROBE_PATH or "ffprobe". */
  ffprobePath?: string;
  /** Kill the process after this many ms (default 10 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export function resolveTools(o: MediaToolsOptions = {}) {
  return {
    ffmpeg: o.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobe: o.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe',
    timeoutMs: o.timeoutMs ?? 10 * 60 * 1000
  };
}

/** Max bytes of stdout captured before the process is killed. */
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** Only the last N bytes of stderr are kept (for error diagnostics). */
export const MAX_STDERR_BYTES = 64 * 1024;
/** Restrict ffmpeg/ffprobe input protocols to local files and pipes (no http, tcp, concat tricks). */
export const PROTOCOL_WHITELIST = ['-protocol_whitelist', 'file,pipe'] as const;

/** Spawn a binary with an argv array (no shell), capturing stdout/stderr. */
export function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal | undefined }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-MAX_STDERR_BYTES);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`Failed to run ${bin}: ${err.message}`, null, stderr));
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (overflow) return reject(new FfmpegError(`${bin} stdout exceeded ${MAX_STDOUT_BYTES} bytes`, code, stderr));
      if (code === 0) resolve({ stdout: Buffer.concat(out).toString(), stderr });
      else reject(new FfmpegError(`${bin} exited with ${code ?? sig}`, code, stderr));
    });
  });
}
