import { ArrowRight, Building2, CheckCircle2, ChevronLeft, ChevronRight, Mail, Sparkles } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

type TourSlide = {
  title: string;
  subtitle: string;
  bullets: Array<{ title: string; desc: string }>;
};

const TOUR_SLIDES: TourSlide[] = [
  {
    title: '1. Automatic Email Sync',
    subtitle:
      'When an inquiry arrives, key parameters are detected directly from the email thread.',
    bullets: [
      {
        title: 'Direct HMS pre-fill:',
        desc: 'Extracted details automatically populate your fields with zero manual re-typing.',
      },
      {
        title: 'Verify auto-filled details:',
        desc: 'During the pilot, please check the email vs the AI auto-filled details to make sure everything is correct.',
      },
    ],
  },
  {
    title: '2. Live Infor HMS Actions & Proof',
    subtitle:
      'Execute live PMS tasks directly without switching windows or navigating Infor HMS manually.',
    bullets: [
      {
        title: 'Automated execution:',
        desc: 'Simply hit run and Nava performs the task directly inside Infor HMS for you.',
      },
      {
        title: 'Inspect screenshot proof:',
        desc: 'Please inspect the live Infor HMS audit capture (full-screen 1000×800) to verify live PMS details.',
      },
    ],
  },
  {
    title: '3. Assisted Responses & Actions',
    subtitle: 'Accelerate daily reservation workflows with AI-assisted drafting.',
    bullets: [
      {
        title: 'Drafted responses & actions:',
        desc: 'Nava prepares suggested replies and action cards directly in your Outlook window.',
      },
      {
        title: 'Check details & tone:',
        desc: 'Always check both the details and the tone of the drafted response before sending the email.',
      },
      {
        title: 'Expanding capabilities:',
        desc: 'Availability quoting is active now; guest lookups, folios, and reservation changes will roll out throughout the pilot.',
      },
    ],
  },
];

/** First-run step 3: the three-slide feature tour. Its last button marks onboarding done and opens the tool. */
export function TourScreen({
  slideIndex,
  setSlideIndex,
  onOpenTool,
}: {
  slideIndex: number;
  setSlideIndex: Dispatch<SetStateAction<number>>;
  onOpenTool: () => void;
}) {
  return (
    <div className="animate-in fade-in nava-pane-scroll flex flex-1 flex-col overflow-y-auto p-3 duration-150">
      <div className="my-auto flex flex-col items-center rounded-sm border border-[#e2e8f0] bg-white p-4 text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#f1f3f6] text-[#1a4332]">
          {slideIndex === 0 && <Mail className="h-5 w-5" />}
          {slideIndex === 1 && <Building2 className="h-5 w-5" />}
          {slideIndex === 2 && <Sparkles className="h-5 w-5" />}
        </div>
        <h2 className="text-sm font-bold text-[#1e293b]">
          {TOUR_SLIDES[slideIndex]?.title}
        </h2>
        <p className="mt-1 text-xs text-[#64748b]">{TOUR_SLIDES[slideIndex]?.subtitle}</p>

        <div className="mt-4 w-full space-y-2 text-left">
          {TOUR_SLIDES[slideIndex]?.bullets.map((b) => (
            <div
              key={b.title}
              className="flex items-start gap-2 rounded-sm bg-[#f8fafc] p-2 text-xs"
            >
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <div>
                <strong className="text-[#1e293b]">{b.title}</strong>{' '}
                <span className="text-[#475569]">{b.desc}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Dots */}
        <div className="my-4 flex justify-center gap-1.5">
          {[0, 1, 2].map((idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setSlideIndex(idx)}
              className={`h-2 rounded-full transition-all ${
                idx === slideIndex ? 'w-5 bg-[#1a4332]' : 'w-2 bg-[#cbd5e1]'
              }`}
              aria-label={`Slide ${idx + 1}`}
            />
          ))}
        </div>

        {/* Prev/Next buttons */}
        <div className="flex w-full items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={slideIndex === 0}
            onClick={() => setSlideIndex((i) => Math.max(0, i - 1))}
            className="flex-1 text-xs"
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Previous
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (slideIndex < TOUR_SLIDES.length - 1) {
                setSlideIndex((i) => i + 1);
              } else {
                if (typeof window !== 'undefined') {
                  try {
                    localStorage.setItem('nava_onboarding_completed', 'true');
                  } catch {
                    // Non-fatal if storage write fails
                  }
                }
                onOpenTool();
                toast.success('Onboarding complete! Opened Infor HMS Quoting Tool');
              }
            }}
            className="flex-1 bg-[#1a4332] text-xs font-semibold text-white hover:bg-[#123023]"
          >
            {slideIndex === TOUR_SLIDES.length - 1 ? (
              <>
                <span>Open Nava</span> <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </>
            ) : (
              <>
                <span>Next</span> <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
