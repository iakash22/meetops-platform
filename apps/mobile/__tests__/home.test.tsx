import { render, screen } from '@testing-library/react-native';

import HomeScreen from '../app/index';

describe('HomeScreen', () => {
  it('renders the title and never claims recording is active', () => {
    render(<HomeScreen />);
    expect(screen.getByText('MeetOps')).toBeTruthy();
    expect(screen.getByTestId('recording-status').props.children).toBe(
      'Recording not available yet',
    );
  });
});
