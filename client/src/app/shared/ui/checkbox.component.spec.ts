import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UiCheckbox } from './checkbox.component';

@Component({
  template: `
    <ui-checkbox [label]="'Test Label'" [(ngModel)]="value" [disabled]="isDisabled"></ui-checkbox>
  `,
  standalone: true,
  imports: [UiCheckbox, FormsModule]
})
class TestHostComponent {
  value = false;
  isDisabled = false;
}

describe('UiCheckbox', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let component: TestHostComponent;
  let checkboxEl: HTMLElement;
  let inputEl: HTMLInputElement;
  let labelEl: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();

    checkboxEl = fixture.debugElement.query(By.directive(UiCheckbox)).nativeElement;
    inputEl = fixture.debugElement.query(By.css('input[type="checkbox"]')).nativeElement;
    labelEl = fixture.debugElement.query(By.css('.checkbox-wrapper')).nativeElement;
  });

  it('should toggle checked state when clicked', async () => {
    expect(component.value).toBe(false);
    expect(inputEl.checked).toBe(false);

    inputEl.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.value).toBe(true);
    expect(inputEl.checked).toBe(true);
    
    inputEl.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.value).toBe(false);
    expect(inputEl.checked).toBe(false);
  });

  it('should toggle when clicking the label', async () => {
    expect(component.value).toBe(false);
    
    labelEl.click();
    fixture.detectChanges();
    await fixture.whenStable();
    
    expect(component.value).toBe(true);
  });

  it('should not toggle when disabled', async () => {
    component.isDisabled = true;
    fixture.detectChanges();
    await fixture.whenStable();
    
    expect(inputEl.disabled).toBe(true);
    
    labelEl.click();
    fixture.detectChanges();
    await fixture.whenStable();
    
    expect(component.value).toBe(false);
    expect(inputEl.checked).toBe(false);
  });
});
