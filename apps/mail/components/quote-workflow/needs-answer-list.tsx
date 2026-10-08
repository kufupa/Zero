export function NeedsAnswerList({
  missing,
}: {
  missing?: Array<{ field: string; question: string }>;
}) {
  if (!missing?.length) return null;
  return (
    <section
      className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3"
      aria-label="Needs your answer"
    >
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Needs your answer</h3>
      <p className="text-[11px] text-[#64748b]">Type the answer into the fields below, or use Tell Luna.</p>
      {missing.map((item) => (
        <p key={`${item.field}:${item.question}`} className="text-[12.5px] text-[#1e293b]">
          {item.question}
        </p>
      ))}
    </section>
  );
}
