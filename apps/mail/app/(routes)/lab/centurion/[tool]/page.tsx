import { CenturionEvalLab } from '@/components/lab/centurion-eval-lab';
import { useLabIndexLoad } from '@/lib/lab/lab-index-context';
import { useNavigate, useParams } from 'react-router';

export default function CenturionLabToolPage() {
  const loaded = useLabIndexLoad();
  const { tool } = useParams();
  const navigate = useNavigate();
  if (!loaded || loaded.source === 'loading') {
    return <CenturionEvalLab />;
  }
  if (loaded.source === 'error') {
    return <CenturionEvalLab error={loaded.error} />;
  }
  return (
    <CenturionEvalLab
      index={loaded.index}
      selectedTool={tool ? decodeURIComponent(tool) : null}
      onToolChange={(next) => {
        navigate(next ? `/lab/centurion/${encodeURIComponent(next)}` : '/lab/centurion');
      }}
    />
  );
}
