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
        <p>Add this information to the fields above.</p>
        {missing.map((item) => (
          <p key={`${item.field}:${item.question}`} className="mt-1">
            {item.question}
          </p>
        ))}
      </Notice>
    </div>
  );
}
