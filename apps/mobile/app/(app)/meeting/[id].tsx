import { Stack, useLocalSearchParams } from 'expo-router';
import { lazy, Suspense } from 'react';

import { useActiveOrganization } from '../../../src/auth/useActiveOrganization';
import { useRepositories } from '../../../src/data/RepositoriesProvider';
import { SkeletonList } from '../../../src/ui/Skeleton';

// Loaded on first open so the transcript/report code stays out of the startup bundle path.
const InsightsScreen = lazy(() =>
  import('../../../src/screens/InsightsScreen').then((m) => ({ default: m.InsightsScreen })),
);

export default function MeetingInsightsRoute() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { organizationId } = useActiveOrganization();
  const { insights } = useRepositories();
  return (
    <>
      <Stack.Screen options={{ title: title || 'Meeting' }} />
      {organizationId && id ? (
        <Suspense fallback={<SkeletonList label="Loading" />}>
          <InsightsScreen api={insights} organizationId={organizationId} meetingId={id} />
        </Suspense>
      ) : null}
    </>
  );
}
