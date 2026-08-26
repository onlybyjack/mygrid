export default function GridMark() {
  return <span className="grid-mark" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</span>;
}
