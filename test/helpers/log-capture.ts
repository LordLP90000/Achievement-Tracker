/** Collects every log line written by a logger so tests can assert on exactly what would be logged. */
export class LogCapture {
  readonly #lines: string[] = [];

  readonly stream = {
    write: (line: string): void => {
      this.#lines.push(line);
    },
  };

  get text(): string {
    return this.#lines.join('');
  }

  records(): Record<string, unknown>[] {
    return this.#lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
