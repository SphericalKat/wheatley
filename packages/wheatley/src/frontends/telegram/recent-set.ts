/** A set that forgets its oldest entries beyond `capacity`. */
export class RecentSet<T> {
  readonly #items = new Set<T>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  readonly has = (item: T): boolean => this.#items.has(item);

  readonly add = (item: T): void => {
    this.#items.add(item);

    for (const oldest of this.#items) {
      if (this.#items.size <= this.#capacity) {
        break;
      }

      this.#items.delete(oldest);
    }
  };
}
