export interface Deferred<T> {
	promise: Promise<T>;
	resolve(value?: T): void;
	reject(reason?: unknown): void;
}

/** Create a promise whose completion is controlled by the test. */
export function deferred<T = void>(): Deferred<T> {
	let resolvePromise!: (value: T | PromiseLike<T>) => void;
	let rejectPromise!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	promise.catch(() => undefined);
	return {
		promise,
		resolve(value?: T): void {
			resolvePromise(value as T);
		},
		reject(reason?: unknown): void {
			rejectPromise(reason);
		},
	};
}
