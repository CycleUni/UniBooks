import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { UiRadioGroup, RadioOption } from './radio-group.component';
import { By } from '@angular/platform-browser';

@Component({
  template: `
    <ui-radio-group [options]="opts1" [(ngModel)]="val1"></ui-radio-group>
    <ui-radio-group [options]="opts2" [(ngModel)]="val2"></ui-radio-group>
  `,
  standalone: true,
  imports: [UiRadioGroup, FormsModule]
})
class TestHostComponent {
  opts1: RadioOption[] = [
    { label: 'A1', value: 'a1' },
    { label: 'B1', value: 'b1' }
  ];
  val1 = 'a1';

  opts2: RadioOption[] = [
    { label: 'A2', value: 'a2' },
    { label: 'B2', value: 'b2' }
  ];
  val2 = 'b2';
}

describe('UiRadioGroup', () => {
  let component: TestHostComponent;
  let fixture: ComponentFixture<TestHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('should update ngModel when an option is clicked', async () => {
    const radioGroups = fixture.debugElement.queryAll(By.directive(UiRadioGroup));
    const firstGroup = radioGroups[0];
    const inputs = firstGroup.queryAll(By.css('input[type="radio"]'));
    
    // Initial state
    expect(component.val1).toBe('a1');
    expect(inputs[0].nativeElement.checked).toBe(true);
    expect(inputs[1].nativeElement.checked).toBe(false);

    // Click second option
    inputs[1].nativeElement.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.val1).toBe('b1');
    expect(inputs[0].nativeElement.checked).toBe(false);
    expect(inputs[1].nativeElement.checked).toBe(true);
  });

  it('should not interfere with other radio groups', async () => {
    const radioGroups = fixture.debugElement.queryAll(By.directive(UiRadioGroup));
    const firstGroupInputs = radioGroups[0].queryAll(By.css('input[type="radio"]'));
    const secondGroupInputs = radioGroups[1].queryAll(By.css('input[type="radio"]'));
    
    // Verify initial distinct names
    const name1 = firstGroupInputs[0].nativeElement.name;
    const name2 = secondGroupInputs[0].nativeElement.name;
    expect(name1).not.toEqual(name2);
    expect(name1).toBeTruthy();

    // Click option in group 2
    secondGroupInputs[0].nativeElement.click();
    fixture.detectChanges();
    await fixture.whenStable();

    // Group 2 updated
    expect(component.val2).toBe('a2');
    expect(secondGroupInputs[0].nativeElement.checked).toBe(true);
    expect(secondGroupInputs[1].nativeElement.checked).toBe(false);

    // Group 1 remains untouched
    expect(component.val1).toBe('a1');
    expect(firstGroupInputs[0].nativeElement.checked).toBe(true);
    expect(firstGroupInputs[1].nativeElement.checked).toBe(false);
  });
});
