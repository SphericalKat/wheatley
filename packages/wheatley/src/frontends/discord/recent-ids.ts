/** Remembers the most recent IDs, oldest out first. */
export class RecentIds {
  readonly #ids = new Set<string>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  add(id: string): void {
    this.#ids.add(id);

    for (const oldest of this.#ids) {
      if (this.#ids.size <= this.#limit) {
        break;
      }

      this.#ids.delete(oldest);
    }
  }
}
