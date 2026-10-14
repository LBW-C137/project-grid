// The overview lays projects out row by row, at most four to a row (App.tsx).
export const gridColumns = (count: number) => Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(count, 1)))));

export type GridDirection = 'left' | 'right' | 'up' | 'down';
// The project beside the current one in the grid (ids in grid order). Left and right go on into the row before or
// after; up and down keep the column, going round from the last row to the first, and into a shorter last row its
// last project. With no current project, right and down start at the first, left and up at the last.
export function gridNeighbor(ids: readonly string[], current: string | null | undefined, direction: GridDirection): string | null {
  const count = ids.length;
  if (!count) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index < 0) return ids[direction === 'right' || direction === 'down' ? 0 : count - 1];
  if (direction === 'left' || direction === 'right') return ids[(index + (direction === 'right' ? 1 : count - 1)) % count];
  const columns = gridColumns(count), rows = Math.ceil(count / columns);
  const row = (Math.floor(index / columns) + (direction === 'down' ? 1 : rows - 1)) % rows;
  return ids[Math.min(row * columns + index % columns, count - 1)];
}
