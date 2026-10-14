export function NeedsAnswerList({
  missing,
}: {
  missing?: Array<{ field: string; question: string }>;
}) {
  if (!missing?.length) return null;
  return (
    <div aria-label="Needs your answer" className="flex flex-col gap-1.5 rounded-[3px] border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-2 text-[13px] text-[#475569]">
      <p className="font-semibold">Needs your answer</p>
      <p>Use the fields below, or the button to jump to them.</p>
      {missing.map((item) => (
        <p key={`${item.field}:${item.question}`} className="mt-1">
          {item.question}
        </p>
      ))}
    </div>
  );
}
