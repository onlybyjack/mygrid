export default function GridMark({ uniform = false }: { uniform?: boolean }) {
  return <span className={`grid-mark${uniform ? " grid-mark-uniform" : ""}`} aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</span>;
}
