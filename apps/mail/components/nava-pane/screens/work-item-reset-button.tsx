/** Grey inline text control. Parent decides when it is shown (a section with a staff edit). */
export function WorkItemResetButton({
  onClick,
  pending = false,
  label = 'Reset to AI',
}: {
  onClick: () => void;
  pending?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className="rounded-[3px] text-[12.5px] font-semibold text-[#64748b] hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:text-[#94a3b8]"
    >
      {label}
    </button>
  );
}
