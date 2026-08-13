/** Poll `predicate` every 5ms until it holds or `ms` elapses (no throw on timeout). */
export async function until(predicate: () => boolean, ms = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate() && Date.now() - start < ms) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
