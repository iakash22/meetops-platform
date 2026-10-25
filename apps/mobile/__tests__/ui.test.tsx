import '@testing-library/react-native/extend-expect';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';

import { Button } from '../src/ui/Button';
import { LiveDot } from '../src/ui/LiveDot';

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
