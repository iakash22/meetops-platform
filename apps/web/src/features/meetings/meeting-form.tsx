import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import type { Meeting } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field } from '@/features/auth/field';
import { useApi } from '@/lib/api/context';
import { queryKeys, useOrganizationId } from '@/lib/api/queries';
import { applyFieldErrors, notify, toastError } from '@/lib/errors/notify';
import { createMeeting, fromLocalInput, toLocalInput, updateMeeting } from './manage-api';

export const meetingFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Enter a title.')
    .max(300, 'Keep the title under 300 characters.'),
  startedAt: z
    .string()
    .refine((v) => v === '' || fromLocalInput(v) !== undefined, 'Enter a valid date and time.'),
});
export type MeetingFormValues = z.infer<typeof meetingFormSchema>;

const FIELD_COPY = { title: 'Enter a valid title.', startedAt: 'Enter a valid date and time.' };

/** Create (no `meeting`) or edit a meeting in a dialog. Field errors inline, other errors toast. */
export function MeetingFormDialog({ meeting }: { meeting?: Meeting }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const editing = !!meeting;
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<MeetingFormValues>({
    resolver: zodResolver(meetingFormSchema),
    mode: 'onTouched',
    defaultValues: { title: meeting?.title ?? '', startedAt: toLocalInput(meeting?.startedAt) },
  });

  const mutation = useMutation({
    mutationFn: (v: MeetingFormValues) => {
      const startedAt = fromLocalInput(v.startedAt);
      const body = { title: v.title.trim(), ...(startedAt ? { startedAt } : {}) };
      return meeting
        ? updateMeeting(api, organizationId, meeting.id, body)
        : createMeeting(api, organizationId, body);
    },
    onSuccess: async (saved) => {
      notify.success(editing ? 'Meeting updated' : 'Meeting created');
      queryClient.setQueryData(queryKeys.meeting(organizationId, saved.id), saved);
      setOpen(false);
      reset({
        title: editing ? saved.title : '',
        startedAt: editing ? toLocalInput(saved.startedAt) : '',
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.meetings(organizationId) });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          className="min-h-11"
          type="button"
          variant={editing ? 'outline' : 'default'}
          disabled={!organizationId}
        >
          {editing ? <Pencil aria-hidden /> : <Plus aria-hidden />}
          {editing ? 'Edit' : 'New meeting'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit meeting' : 'New meeting'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the title or start time.'
              : 'Add a meeting, then upload its recording.'}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(e) =>
            void handleSubmit(async (v) => {
              try {
                await mutation.mutateAsync(v);
              } catch (err) {
                if (!applyFieldErrors(setError, err, FIELD_COPY)) toastError(err);
              }
            })(e)
          }
        >
          <Field
            label="Title"
            maxLength={300}
            error={errors.title?.message}
            {...register('title')}
          />
          <Field
            label="Start time"
            type="datetime-local"
            error={errors.startedAt?.message}
            {...register('startedAt')}
          />
          <DialogFooter>
            <Button className="min-h-11" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : editing ? 'Save changes' : 'Create meeting'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
