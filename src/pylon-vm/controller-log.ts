/** How a line of a controller log starts: the time it was written. */
export const stamped = (line: string, at = new Date()) => `${at.toISOString()} ${line}`;

/** A controller log's line without its time, which lines written before the stamp lack. */
export const unstamped = (line: string) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, "");

/** Starts every line written to `stream` from now on, in any number of writes, with the time it was written. */
export function stampLines(stream: NodeJS.WriteStream): void {
	const write = stream.write.bind(stream) as (chunk: string, ...rest: unknown[]) => boolean;
	let lineStart = true;
	stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (text === "") return write(text, ...rest);
		const at = new Date();
		let out = "";
		for (const piece of text.split(/(?<=\n)/)) {
			out += lineStart ? stamped(piece, at) : piece;
			lineStart = piece.endsWith("\n");
		}
		return write(out, ...rest.filter((arg) => typeof arg === "function"));
	}) as typeof stream.write;
}
