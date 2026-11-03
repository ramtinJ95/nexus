/** How a line of a controller log starts: the time it was written. */
export const stamped = (line: string, at = new Date()) => `${at.toISOString()} ${line}`;

/** A controller log's line without its time, which lines written before the stamp lack. */
export const unstamped = (line: string) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, "");

/** Starts every line written to `stream` from now on, in any number of writes, with the time it was written. It works on bytes, so a character split across writes stays whole. */
export function stampLines(stream: NodeJS.WriteStream): void {
	const write = stream.write.bind(stream) as (chunk: Uint8Array, callback?: (error?: Error | null) => void) => boolean;
	let lineStart = true;
	stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk);
		const done = typeof encoding === "function" ? encoding : callback;
		const stamp = Buffer.from(stamped(""));
		const parts: Buffer[] = [];
		for (let from = 0; from < bytes.length; ) {
			if (lineStart) parts.push(stamp);
			const newline = bytes.indexOf(0x0a, from);
			const to = newline === -1 ? bytes.length : newline + 1;
			parts.push(bytes.subarray(from, to));
			lineStart = newline !== -1;
			from = to;
		}
		return write(Buffer.concat(parts), done);
	}) as typeof stream.write;
}
