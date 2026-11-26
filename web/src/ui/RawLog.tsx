import { useOffice } from '../state/store';
import { useFollow } from './useFollow';

const EMPTY: string[] = [];

/** Every `log.raw` line of the ticket; follows the tail, pauses while scrolled up. */
export function RawLog({ ticketId }: { ticketId: string }) {
  const lines = useOffice(s => s.raw[ticketId] ?? EMPTY);
  const { ref, paused, onScroll, follow } = useFollow<HTMLPreElement>(lines.length);
  return (
    <div className="po-scroll-wrap">
      <pre className="po-scroll po-raw" ref={ref} onScroll={onScroll}>
        {lines.length === 0 && <span className="po-dim">(no log lines yet)</span>}
        {lines.map((l, i) => {
          const m = /^(\[[^\]]+\])(.*)$/.exec(l);
          return <span key={i} className="po-raw-line">{m ? <><span className="po-raw-tag">{m[1]}</span>{m[2]}</> : l}{'\n'}</span>;
        })}
      </pre>
      {paused && <button type="button" className="po-follow" onClick={follow}>⏸ paused · ↓ follow</button>}
    </div>
  );
}
