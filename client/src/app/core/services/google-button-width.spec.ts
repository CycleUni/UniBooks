import { buttonWidthFor } from './google-auth.service';

describe('buttonWidthFor', () => {
  const box = (width: number) => ({ clientWidth: width }) as HTMLElement;

  it("follows the container within Google's 200–400 px range", () => {
    expect(buttonWidthFor(box(320))).toBe(320);
    expect(buttonWidthFor(box(150))).toBe(200);
    expect(buttonWidthFor(box(720))).toBe(400);
    expect(buttonWidthFor(box(287.6))).toBe(287);
  });

  it('uses a default while the container has no width yet', () => {
    expect(buttonWidthFor(box(0))).toBe(280);
  });
});
