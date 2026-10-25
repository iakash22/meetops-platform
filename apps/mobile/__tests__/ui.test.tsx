import '@testing-library/react-native/extend-expect';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';

import { colors } from '../src/theme/colors';

import { Button } from '../src/ui/Button';
import { LiveDot } from '../src/ui/LiveDot';
import { SkeletonList } from '../src/ui/Skeleton';
import { EmptyState, ErrorState } from '../src/ui/StateViews';

function setReducedMotion(value: boolean) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(value);
}

afterEach(() => jest.restoreAllMocks());

describe('motion respects reduced-motion', () => {
  it('animates the CTA press when motion is allowed', async () => {
    setReducedMotion(false);
    const spring = jest
      .spyOn(Animated, 'spring')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
    const onPress = jest.fn();
    render(<Button testID="cta" label="Go" onPress={onPress} />);
    await act(async () => {});
    fireEvent(screen.getByTestId('cta'), 'pressIn');
    fireEvent.press(screen.getByTestId('cta'));
    expect(spring).toHaveBeenCalled();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('skips the press animation and live pulse when reduce motion is on', async () => {
    setReducedMotion(true);
    const spring = jest.spyOn(Animated, 'spring');
    const loop = jest.spyOn(Animated, 'loop');
    const onPress = jest.fn();
    render(
      <>
        <Button testID="cta" label="Go" onPress={onPress} />
        <LiveDot testID="dot" />
      </>,
    );
    await act(async () => {});
    loop.mockClear();
    fireEvent(screen.getByTestId('cta'), 'pressIn');
    fireEvent.press(screen.getByTestId('cta'));
    expect(spring).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('dot', { includeHiddenElements: true })).toBeTruthy();
  });

  it('disables the button while loading', async () => {
    const onPress = jest.fn();
    render(<Button testID="cta" label="Go" onPress={onPress} loading />);
    await act(async () => {});
    fireEvent.press(screen.getByTestId('cta'));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId('cta')).toBeDisabled();
  });
});

describe('skeleton and state views', () => {
  it('shimmers the skeleton only when motion is allowed', async () => {
    const loop = jest
      .spyOn(Animated, 'loop')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
    setReducedMotion(true);
    const { unmount } = render(<SkeletonList testID="sk" label="Loading things" />);
    await act(async () => {});
    expect(screen.getByTestId('sk')).toBeBusy();
    expect(screen.getByLabelText('Loading things')).toBeTruthy();
    loop.mockClear();
    unmount();

    setReducedMotion(false);
    render(<SkeletonList testID="sk" label="Loading things" />);
    await act(async () => {});
    expect(loop).toHaveBeenCalled();
  });

  it('error state announces an alert in the destructive colour and retries', () => {
    const onRetry = jest.fn();
    render(<ErrorState testID="err" message="Couldn't load." onRetry={onRetry} />);
    const msg = screen.getByRole('alert');
    expect(StyleSheet.flatten(msg.props.style).color).toBe(colors.destructive);
    fireEvent.press(screen.getByTestId('err-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('empty state exposes title and body as one label', () => {
    render(<EmptyState testID="empty" title="Nothing here" body="Add something." />);
    expect(screen.getByTestId('empty')).toHaveProp(
      'accessibilityLabel',
      'Nothing here. Add something.',
    );
  });
});
