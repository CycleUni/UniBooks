import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { UiTextarea } from './textarea.component';
import { By } from '@angular/platform-browser';

@Component({
  template: `
    <ui-textarea [(ngModel)]="text"></ui-textarea>
    <ui-textarea [disabled]="disabled" class="disabled-test"></ui-textarea>
  `,
  standalone: true,
  imports: [UiTextarea, FormsModule]
})
class TestHostComponent {
  text = 'initial';
  disabled = false;
}

describe('UiTextarea', () => {
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

  it('should update ngModel when input changes', async () => {
    const textarea = fixture.debugElement.query(By.css('textarea')).nativeElement;
    
    // Initial value
    expect(textarea.value).toBe('initial');
    
    // Simulate user typing
    textarea.value = 'new text';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.text).toBe('new text');
  });
});
