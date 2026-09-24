import { CenturionEvalLab } from '@/components/lab/centurion-eval-lab';
import { useLabIndexLoad } from '@/lib/lab/lab-index-context';
import { useNavigate } from 'react-router';

export default function CenturionLabPage() {
  const loaded = useLabIndexLoad();
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
      onToolChange={(tool) => {
        navigate(tool ? `/lab/centurion/${encodeURIComponent(tool)}` : '/lab/centurion');
      }}
    />
  );
}
