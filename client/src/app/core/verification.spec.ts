import { describe, it, expect } from 'vitest';
import {
  domainMatchesSuffix,
  getSchoolDomainChoices,
  splitEmailAddress,
  findSchoolForDomain,
} from './verification';
import { SchoolOption } from './services/school-state.service';

describe('verification core utilities', () => {
  describe('domainMatchesSuffix', () => {
    it('matches exact domain and subdomains', () => {
      expect(domainMatchesSuffix('ntu.edu.tw', 'edu.tw')).toBe(true);
      expect(domainMatchesSuffix('csie.ntu.edu.tw', 'ntu.edu.tw')).toBe(true);
      expect(domainMatchesSuffix('evilntu.edu.tw', 'ntu.edu.tw')).toBe(false);
      expect(domainMatchesSuffix('hku.hk', '.hku.hk')).toBe(true);
      expect(domainMatchesSuffix('connect.hku.hk', 'hku.hk')).toBe(true);
    });
  });

  describe('getSchoolDomainChoices', () => {
    it('returns empty array when school is null or undefined', () => {
      expect(getSchoolDomainChoices(null)).toEqual([]);
      expect(getSchoolDomainChoices(undefined)).toEqual([]);
    });

    it('orders student_email_domain first, followed by unique accepted domains', () => {
      const school: SchoolOption = {
        id: 1,
        code: 'CHIHLEE',
        name: 'Chihlee University of Technology',
        email_domain: 'chihlee.edu.tw',
        email_domains: ['gm.chihlee.edu.tw', 'mail.chihlee.edu.tw'],
        student_email_domain: 'gm.chihlee.edu.tw',
        google_domains: ['gm.chihlee.edu.tw'],
        accepted_domains: ['chihlee.edu.tw', 'gm.chihlee.edu.tw', 'mail.chihlee.edu.tw'],
      };
      const choices = getSchoolDomainChoices(school);
      expect(choices).toEqual([
        'gm.chihlee.edu.tw',
        'mail.chihlee.edu.tw',
      ]);
    });

    it('offers no domain for a school that lists none: its website domain is not a mailbox domain', () => {
      const school: SchoolOption = {
        id: 2,
        code: 'NTU',
        name: 'National Taiwan University',
        email_domain: 'ntu.edu.tw',
      };
      expect(getSchoolDomainChoices(school)).toEqual([]);
    });
  });

  describe('splitEmailAddress', () => {
    it('splits valid email addresses', () => {
      expect(splitEmailAddress('user@example.com')).toEqual({
        localPart: 'user',
        domain: 'example.com',
      });
      expect(splitEmailAddress('  student.123@GM.Chihlee.Edu.TW  ')).toEqual({
        localPart: 'student.123',
        domain: 'gm.chihlee.edu.tw',
      });
    });

    it('returns null for invalid inputs', () => {
      expect(splitEmailAddress('')).toBeNull();
      expect(splitEmailAddress('notanemail')).toBeNull();
      expect(splitEmailAddress('@domain.com')).toBeNull();
      expect(splitEmailAddress('user@')).toBeNull();
      expect(splitEmailAddress('a@b@c.com')).toBeNull();
    });
  });

  describe('findSchoolForDomain', () => {
    const schools: SchoolOption[] = [
      {
        id: 1,
        code: 'NTU',
        name: 'National Taiwan University',
        email_domain: 'ntu.edu.tw',
        student_email_domain: 'ntu.edu.tw',
        accepted_domains: ['ntu.edu.tw'],
      },
      {
        id: 2,
        code: 'CHIHLEE',
        name: 'Chihlee University of Technology',
        email_domain: 'chihlee.edu.tw',
        email_domains: ['gm.chihlee.edu.tw', 'mail.chihlee.edu.tw'],
        student_email_domain: 'gm.chihlee.edu.tw',
        google_domains: ['gm.chihlee.edu.tw'],
        accepted_domains: ['chihlee.edu.tw', 'gm.chihlee.edu.tw', 'mail.chihlee.edu.tw'],
      },
    ];

    it('finds exact domain match', () => {
      const result = findSchoolForDomain(schools, 'gm.chihlee.edu.tw');
      expect(result).not.toBeNull();
      expect(result?.school.code).toBe('CHIHLEE');
      expect(result?.matchedDomain).toBe('gm.chihlee.edu.tw');
    });

    it('finds deepest matching parent domain for unlisted subdomains', () => {
      const result = findSchoolForDomain(schools, 'csie.ntu.edu.tw');
      expect(result).not.toBeNull();
      expect(result?.school.code).toBe('NTU');
      expect(result?.matchedDomain).toBe('ntu.edu.tw');
    });

    it('returns null for unknown domain', () => {
      expect(findSchoolForDomain(schools, 'gmail.com')).toBeNull();
      expect(findSchoolForDomain(schools, 'other.edu.tw')).toBeNull();
    });
  });
});
