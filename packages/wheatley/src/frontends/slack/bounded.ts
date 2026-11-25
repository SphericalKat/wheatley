/** A `Map` or `Set` whose iteration order is insertion order. */
interface InsertionOrdered<K> {
  readonly size: number;
  readonly keys: () => IterableIterator<K>;
  readonly delete: (key: K) => boolean;
}

/** Deletes the oldest entries of `collection` until it has at most `max` entries. */
export const dropOldest = <K>(
  collection: InsertionOrdered<K>,
  max: number
): void => {
  for (const oldest of collection.keys()) {
    if (collection.size <= max) {
      break;
    }

    collection.delete(oldest);
  }
};
