import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { UiInput } from './input.component';

@Component({
  template: `
    <ui-input class="labelled" label="Course" [(ngModel)]="course"></ui-input>
    <ui-input class="labelled-2" label="Professor"></ui-input>
    <label for="login-email" class="outside-label">Email</label>
    <ui-input
      class="forwarded"
      inputId="login-email"
      type="email"
      name="email"
      autocomplete="username"
      inputmode="email"
      ariaDescribedby="auth-msg"
    ></ui-input>
    <ui-input class="unlabelled" ariaLabel="Search" placeholder="Search..."></ui-input>
  `,
  standalone: true,
  imports: [UiInput, FormsModule]
})
class TestHostComponent {
  course = '';
}

describe('UiInput', () => {
  let fixture: ComponentFixture<TestHostComponent>;

  const inputIn = (selector: string): HTMLInputElement =>
    fixture.debugElement.query(By.css(`${selector} input`)).nativeElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TestHostComponent] }).compileComponents();
    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('ties its own label to the field', () => {
    const input = inputIn('.labelled');
    expect(input.labels?.length).toBe(1);
    expect(input.labels?.[0].textContent?.trim()).toBe('Course');
  });

  it('gives every instance a distinct generated id', () => {
    expect(inputIn('.labelled').id).toBeTruthy();
    expect(inputIn('.labelled').id).not.toBe(inputIn('.labelled-2').id);
  });

  it('uses a caller-supplied id so a label outside the component can point at it', () => {
    const input = inputIn('.forwarded');
    expect(input.id).toBe('login-email');
    expect(input.labels?.[0].textContent?.trim()).toBe('Email');
    // Only the inner field carries the id; a duplicate on the host would break
    // label lookup.
    expect(fixture.nativeElement.querySelectorAll('#login-email').length).toBe(1);
  });

  it('forwards type, name, autocomplete, inputmode and aria-describedby to the inner input', () => {
    const input = inputIn('.forwarded');
    expect(input.type).toBe('email');
    expect(input.getAttribute('name')).toBe('email');
    expect(input.getAttribute('autocomplete')).toBe('username');
    expect(input.getAttribute('inputmode')).toBe('email');
    expect(input.getAttribute('aria-describedby')).toBe('auth-msg');
  });

  it('names a field with no visible label through aria-label', () => {
    expect(inputIn('.unlabelled').getAttribute('aria-label')).toBe('Search');
  });

  it('leaves unset attributes off rather than rendering them empty', () => {
    const input = inputIn('.labelled');
    expect(input.hasAttribute('autocomplete')).toBe(false);
    expect(input.hasAttribute('aria-label')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });
});
