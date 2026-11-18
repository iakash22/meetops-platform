import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** Pick an option in a shared Radix Select; the listbox renders in a portal. */
export async function chooseSelect(label: string | RegExp, option: string, scope?: HTMLElement) {
  const root = scope ? within(scope) : screen;
  await userEvent.click(root.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}
