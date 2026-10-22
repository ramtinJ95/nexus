// Feasibility adapter: unsupported capabilities fail explicitly, not production-complete.
import path from 'node:path';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { ok, err, FileError, ExecutionError } from '@earendil-works/pi-durable/env';

export class GondolinExecutionEnv {
  constructor(vm, cwd = '/root/nexus-s3') {
    this.vm = vm;
    this.cwd = cwd;
    this.id = `gondolin:${randomUUID()}`;
    this.running = new Set();
    for (const method of ['openTextLineReader', 'openBinaryReader', 'appendFile', 'truncateFile',
      'flushFile', 'openDirReader', 'watch', 'createTempDir', 'createTempFile']) {
      this[method] = async () => err(new FileError('not_supported', `${method}: not implemented in feasibility adapter`));
    }
  }
  resolve(p) { return path.posix.resolve(this.cwd, p); }
  async fileOp(p, context, fn) {
    try { context.abortSignal?.throwIfAborted(); return ok(await fn(this.resolve(p))); }
    catch (e) {
      const code = context.abortSignal?.aborted ? 'aborted' :
        ({ ENOENT: 'not_found', EACCES: 'permission_denied', ENOTDIR: 'not_directory', EISDIR: 'is_directory' })[e.code] ?? 'unknown';
      return err(new FileError(code, e.message, p, e));
    }
  }
  async absolutePath(p, c) { return this.fileOp(p, c, p => p); }
  async joinPath(parts, c) { return this.fileOp('.', c, () => path.posix.join(...parts)); }
  readTextFile(p, c) { return this.fileOp(p, c, p => this.vm.fs.readFile(p, { encoding: 'utf8', signal: c.abortSignal })); }
  readBinaryFile(p, c) { return this.fileOp(p, c, p => this.vm.fs.readFile(p, { signal: c.abortSignal })); }
  async readTextLines(p, options, c) {
    const r = await this.readTextFile(p, c);
    return r.ok ? ok(r.value.split('\n').slice(0, options?.maxLines)) : r;
  }
  writeFile(p, content, c) {
    return this.fileOp(p, c, async p => {
      await this.vm.fs.mkdir(path.posix.dirname(p), { recursive: true, signal: c.abortSignal });
      await this.vm.fs.writeFile(p, content, { signal: c.abortSignal });
    });
  }
  renameFile(a, b, c) { return this.fileOp(a, c, p => this.vm.fs.rename(p, this.resolve(b), { signal: c.abortSignal })); }
  createDir(p, o, c) { return this.fileOp(p, c, p => this.vm.fs.mkdir(p, { ...o, signal: c.abortSignal })); }
  remove(p, o, c) { return this.fileOp(p, c, p => this.vm.fs.deleteFile(p, { ...o, signal: c.abortSignal })); }
  async fileInfo(p, c) {
    return this.fileOp(p, c, async p => {
      const s = await this.vm.fs.stat(p, { signal: c.abortSignal });
      return { name: path.posix.basename(p), path: p, kind: s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'file', size: s.size, mtimeMs: s.mtimeMs };
    });
  }
  async listDir(p, c) {
    return this.fileOp(p, c, async p => {
      const names = await this.vm.fs.listDir(p, { signal: c.abortSignal });
      return Promise.all(names.map(async name => {
        const r = await this.fileInfo(path.posix.join(p, name), c);
        if (!r.ok) throw r.error;
        return r.value;
      }));
    });
  }
  async canonicalPath(p, c) {
    return this.fileOp(p, c, async p => {
      const r = await this.vm.exec(['realpath', p], { signal: c.abortSignal });
      if (r.exitCode) throw new Error(r.stderr);
      return r.stdout.trim();
    });
  }
  async exists(p, c) {
    const r = await this.fileInfo(p, c);
    return r.ok ? ok(true) : r.error.code === 'not_found' ? ok(false) : r;
  }
  async exec(command, options = {}, context) {
    const abort = new AbortController();
    this.running.add(abort);
    const signals = [abort.signal, context.abortSignal].filter(Boolean);
    let timedOut = false;
    const timer = options.timeout === undefined ? undefined : setTimeout(() => { timedOut = true; abort.abort(); }, options.timeout * 1000);
    const signal = AbortSignal.any(signals);
    const chunks = [];
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const output = stream => new Writable({ write(chunk, _encoding, done) {
      try {
        chunks.push(Buffer.from(chunk));
        options.onOutput?.(decoders[stream].write(chunk), context, { stream });
        done();
      } catch (e) { done(e); }
    }});
    try {
      // The fixture relies on the guest defaults. Don't silently claim inheritEnv=false.
      if (options.inheritEnv === false) throw new Error('inheritEnv=false is unsupported by this minimal adapter');
      const r = await this.vm.exec(command, { cwd: options.cwd ?? this.cwd, env: options.env,
        signal, stdout: output('stdout'), stderr: output('stderr') });
      for (const stream of ['stdout', 'stderr']) {
        const rest = decoders[stream].end();
        if (rest) options.onOutput?.(rest, context, { stream });
      }
      const raw = Buffer.concat(chunks);
      let spillPath;
      if (options.spill && (raw.length > options.spill.afterBytes || raw.toString().split('\n').length > options.spill.afterLines)) {
        spillPath = `/tmp/nexus-spill-${randomUUID()}`;
        await this.vm.fs.writeFile(spillPath, raw);
      }
      return ok({ exitCode: r.exitCode, ...(spillPath ? { spillPath } : {}) });
    } catch (e) {
      return err(new ExecutionError(timedOut ? 'timeout' : signal.aborted ? 'aborted' : 'unknown', e.message, e));
    } finally { clearTimeout(timer); this.running.delete(abort); }
  }
  async cleanup() { for (const a of this.running) a.abort(); }
}
