import { copyFile, rename, stat, truncate } from "node:fs/promises";
import { existsError } from "./storage.ts";

export const controllerLogLimit = { maxBytes: 10 * 2 ** 20, kept: 2 };

/**
 * Once `file` holds `maxBytes`, moves its older copies up one, `<file>.1` to `<file>.2` and so on up to `kept`, copies it
 * to `<file>.1` and truncates it. It is copied rather than renamed because the controller's stdout and stderr stay open
 * on it, and every writer appends, so what they write next starts the emptied file. A line written between the copy
 * and the truncate is lost. Returns whether it rotated.
 */
export async function rotateLog(file: string, { maxBytes, kept }: typeof controllerLogLimit): Promise<boolean> {
	const size = await stat(file).then((s) => s.size, (err: unknown) => existsError(err, "ENOENT") ? 0 : Promise.reject(err));
	if (size < maxBytes) return false;
	for (let i = kept - 1; i >= 1; i--) {
		await rename(`${file}.${i}`, `${file}.${i + 1}`).catch((err: unknown) => existsError(err, "ENOENT") ? undefined : Promise.reject(err));
	}
	await copyFile(file, `${file}.1`);
	await truncate(file, 0);
	return true;
}
