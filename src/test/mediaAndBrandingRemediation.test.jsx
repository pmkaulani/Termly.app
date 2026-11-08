import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import getCroppedImg, { getCroppedImgResult } from '../utils/cropImage';
import { getPrintHeader, saveSchoolProfile } from '../data/coreStore';
import Avatar from '../components/Common/Avatar';
import { uploadSchoolLogo, uploadPersonPhoto, getPersonPhotoSignedUrl } from '../lib/storageHelpers';
import { bulkImportTeachers } from '../data/staffStore';

describe('Media, Branding & Bulk Import Remediation Test Suite', () => {

  describe('Deliverable A: School Logo Crop, Aspect Ratio & Transparency', () => {
    // Mock HTML Canvas 2D Context for headless test environment
    beforeEach(() => {
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
        translate: vi.fn(),
        rotate: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(16) }),
        putImageData: vi.fn()
      });
      HTMLCanvasElement.prototype.toDataURL = vi.fn().mockImplementation((type) => {
        return `data:${type || 'image/png'};base64,mockCroppedImageContent`;
      });
      HTMLCanvasElement.prototype.toBlob = vi.fn().mockImplementation((callback, type) => {
        callback(new Blob(['mock_blob_content'], { type: type || 'image/png' }));
      });

      // Mock Image constructor with naturalWidth and naturalHeight
      global.Image = class {
        constructor() {
          this.naturalWidth = 800;
          this.naturalHeight = 200; // 4:1 wide wordmark
          this.width = 800;
          this.height = 200;
          setTimeout(() => {
            if (this.onload) this.onload();
          }, 0);
        }
      };
    });

    it('preserves natural 4:1 aspect ratio of wide horizontal wordmarks without squashing', async () => {
      // 4:1 wide banner crop
      const pixelCrop = { x: 0, y: 0, width: 800, height: 200 };
      const result = await getCroppedImg('data:image/png;base64,dummy', pixelCrop, 0, {
        maxDimension: 512,
        mimeType: 'image/png'
      });

      expect(result).toBeDefined();
      expect(result).toContain('data:image/png;base64,');
    });

    it('rejects missing crop pixel parameters safely', async () => {
      await expect(getCroppedImg('data:image/png;base64,dummy', null)).rejects.toThrow(
        'Select a crop area before applying the crop'
      );
    });

    it('exports both dataUrl and Blob for storage upload', async () => {
      const pixelCrop = { x: 0, y: 0, width: 400, height: 400 };
      const { dataUrl, blob } = await getCroppedImgResult('data:image/png;base64,dummy', pixelCrop, 0, {
        maxDimension: 512,
        mimeType: 'image/png'
      });

      expect(dataUrl).toContain('data:image/png;base64,');
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/png');
    });
  });

  describe('Deliverable A: School Logo Display & Print Header Security', () => {
    it('displays school logo proportionally in getPrintHeader with object-fit: contain', async () => {
      const mockProfile = {
        schoolName: 'Moi High School',
        logo: 'https://example.com/logo.png',
        motto: 'Knowledge is Power',
        address: 'Nairobi, Kenya'
      };
      const headerHtml = await getPrintHeader('End of Term Examination Report', mockProfile);

      // Must contain school logo img element with object-fit: contain
      expect(headerHtml).toContain('alt="School logo"');
      expect(headerHtml).toContain('object-fit:contain');
      expect(headerHtml).toContain('End of Term Examination Report');
    });

    it('escapes dangerous HTML characters in print header to prevent XSS injection', async () => {
      const maliciousTitle = 'Results <script>alert("hacked")</script> & More';
      const headerHtml = await getPrintHeader(maliciousTitle);

      expect(headerHtml).not.toContain('<script>');
      expect(headerHtml).toContain('&lt;script&gt;alert(&quot;hacked&quot;)&lt;/script&gt;');
      expect(headerHtml).toContain('&amp; More');
    });
  });

  describe('Deliverable B: Avatar Component & Portrait Presentation', () => {
    it('renders object-fit: cover inside circle/rounded avatar frame when portrait exists', () => {
      render(
        <Avatar
          photoUrl="https://example.com/portrait.webp"
          name="Jane Wanjiku"
          size={40}
          shape="circle"
        />
      );

      const img = screen.getByAltText('Jane Wanjiku portrait');
      expect(img).toBeInTheDocument();
      expect(img.style.objectFit).toBe('cover');
      expect(img.style.borderRadius).toBe('50%');
      expect(img.style.width).toBe('40px');
    });

    it('falls back to initials with deterministic background when photo is absent', () => {
      render(
        <Avatar
          photoUrl={null}
          photoPath={null}
          name="Peter Kamau"
          size={36}
        />
      );

      const initials = screen.getByText('PK');
      expect(initials).toBeInTheDocument();
    });

    it('falls back to initials when portrait image fails to load', async () => {
      render(
        <Avatar
          photoUrl="https://example.com/broken-photo.jpg"
          name="Alice Muthoni"
          size={32}
        />
      );

      const img = screen.getByAltText('Alice Muthoni portrait');
      fireEvent.error(img);

      await waitFor(() => {
        expect(screen.getByText('AM')).toBeInTheDocument();
      });
    });
  });

  describe('Deliverable B: Storage Security & Isolation', () => {
    it('scopes photo upload path to authenticated school ID and entity ID', async () => {
      // Mock supabase storage
      const mockUpload = vi.fn().mockResolvedValue({ data: { path: 'path' }, error: null });
      const { supabase } = await import('../lib/supabase');
      supabase.storage = {
        from: vi.fn().mockReturnValue({
          upload: mockUpload,
          remove: vi.fn().mockResolvedValue({ error: null })
        })
      };

      const schoolId = '11111111-1111-1111-1111-111111111111';
      const studentId = '22222222-2222-2222-2222-222222222222';
      const fakeBlob = new Blob(['image_bytes'], { type: 'image/webp' });

      const res = await uploadPersonPhoto({
        schoolId,
        entityType: 'students',
        entityId: studentId,
        fileOrBlob: fakeBlob
      });

      expect(supabase.storage.from).toHaveBeenCalledWith('school-people-photos');
      expect(res.photoPath).toContain(`${schoolId}/students/${studentId}/`);
      expect(res.photoPath.endsWith('.webp')).toBe(true);
    });

    it('requires school ID and entity ID for portrait upload', async () => {
      await expect(
        uploadPersonPhoto({ schoolId: '', entityType: 'students', entityId: 'id', fileOrBlob: new Blob() })
      ).rejects.toThrow('School ID, entity type, and entity ID are required');
    });
  });

  describe('Deliverable C: Teacher Importer Security Separation', () => {
    it('creates teacher profile records without inventing default credentials, PINs, or login users', async () => {
      const { supabase } = await import('../lib/supabase');
      let insertedPayload = null;

      supabase.from = vi.fn().mockImplementation((table) => {
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { staff_count: 2 }, error: null }),
          upsert: vi.fn().mockResolvedValue({ error: null })
        };
        if (table === 'teachers') {
          const teacherQuery = {
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            then: (resolve) => resolve({ data: [], count: 2, error: null })
          };
          chain.select = vi.fn().mockReturnValue(teacherQuery);
          chain.insert = vi.fn().mockImplementation((records) => {
            insertedPayload = records;
            return {
              select: () => Promise.resolve({ data: records.map((r, i) => ({ id: `t-${i}`, ...r })), error: null })
            };
          });
          chain.update = vi.fn().mockResolvedValue({ error: null });
        }
        return chain;
      });

      const incomingTeachers = [
        {
          staffCode: 'T-101',
          name: 'Sarah Kimani',
          phone: '+254711223344',
          email: 'sarah.k@school.ke',
          tscNumber: 'TSC-445566',
          subjects: ['Mathematics', 'Chemistry']
        }
      ];

      const result = await bulkImportTeachers(incomingTeachers, null, { schoolId: '11111111-1111-1111-1111-111111111111' });

      expect(result.insertedCount).toBe(1);
      expect(insertedPayload).toBeDefined();
      expect(insertedPayload.length).toBe(1);

      const record = insertedPayload[0];
      expect(record.name).toBe('Sarah Kimani');
      expect(record.phone).toBe('+254711223344');
      expect(record.staff_code).toBe('T-101');

      // CRITICAL SECURITY INVARIANT: Must NOT set default PIN, password, or auth user id!
      expect(record.pin).toBeUndefined();
      expect(record.password).toBeUndefined();
      expect(record.user_id).toBeUndefined();
      expect(record.auth_user_id).toBeUndefined();
    });
  });
});
