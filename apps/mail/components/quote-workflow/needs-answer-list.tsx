import { Notice } from '@/components/nava-pane/pane-ui';

export function NeedsAnswerList({
  missing,
}: {
  missing?: Array<{ field: string; question: string }>;
}) {
  if (!missing?.length) return null;
  return (
    <div aria-label="Needs your answer" className="flex flex-col gap-1.5">
      <Notice tone="warn">
        <p className="font-semibold">Needs your answer</p>
        <p>Type the answer into the fields above, or use Tell Nava at the top.</p>
        {missing.map((item) => (
          <p key={`${item.field}:${item.question}`} className="mt-1">
            {item.question}
          </p>
        ))}
      </Notice>
    </div>
  );
}
