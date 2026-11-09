import { supabase } from '../lib/supabase';
import { getCurrentSchoolId, _currentAuthUser } from './coreStore';;

// ============================================================================
// LIBRARY MODULE: API LAYER
// ============================================================================
export async function getStudentBooks(studentId) {
  const schoolId = getSchoolId();
  if (!schoolId || !studentId) return [];

  // Portal mode: anonymous sessions need a SECURITY DEFINER RPC because
  // RLS cannot rely on auth.uid() for parent portal access.
  if (!_currentAuthUser) {
    const { data, error } = await supabase.rpc('portal_get_student_books', {
      p_student_id: studentId,
    });
    if (error) {
      console.error('[Portal] Student books RPC failed:', error.message);
      throw error;
    }
    const today = new Date().toISOString().slice(0, 10);
    return (Array.isArray(data) ? data : []).map(book => ({
      ...book,
      issue_date: book.issue_date || book.borrow_date || null,
      is_overdue: Boolean(book.is_overdue || (book.due_date && book.due_date < today)),
    }));
  }

  const { data, error } = await supabase
    .from('borrow_records')
    .select('id, borrow_date, due_date, status, book_copies(copy_code, books(title, author, isbn))')
    .eq('student_id', studentId)
    .eq('school_id', schoolId)
    .eq('status', 'borrowed');
  if (error) throw error;

  return (data || []).map(record => ({
    id: record.id,
    title: record.book_copies?.books?.title,
    author: record.book_copies?.books?.author,
    isbn: record.book_copies?.books?.isbn,
    copy_code: record.book_copies?.copy_code,
    issue_date: record.borrow_date,
    due_date: record.due_date,
    status: record.status,
    is_overdue: record.due_date < new Date().toISOString().split('T')[0],
  }));
}

const getSchoolId = () => {
    const id = getCurrentSchoolId();
    if (!id) throw new Error("No active school context found.");
    return id;
};

// --- BOOKS ---

export async function getLibraryBooks(filters = {}) {
    const { search, category, subject, level } = filters;
    let query = supabase.from('books').select('*, book_copies(id, status, copy_code)').eq('school_id', getSchoolId());

    if (category) query = query.eq('category', category);
    if (subject) query = query.eq('subject', subject);
    if (level) query = query.eq('level', level);
    if (search) {
        query = query.or(`title.ilike.%${search}%,author.ilike.%${search}%,isbn.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Calculate copies
    return data.map(book => {
        const copies = book.book_copies || [];
        return {
            ...book,
            total_copies: copies.length,
            available_copies: copies.filter(c => c.status === 'available').length,
            borrowed_copies: copies.filter(c => c.status === 'borrowed').length
        };
    });
}

export async function createBook(bookData) {
    const { data, error } = await supabase.from('books').insert({
        school_id: getSchoolId(),
        ...bookData
    }).select().single();
    
    if (error) throw error;
    return data;
}

export async function updateBook(id, bookData) {
    const { data, error } = await supabase.from('books').update(bookData)
        .eq('id', id).eq('school_id', getSchoolId()).select().single();
    
    if (error) throw error;
    return data;
}

export async function deleteBook(id) {
    // Constraint: only delete if no active borrow records
    // This is handled partly by cascading or by checking first. Let's explicitly check.
    const { count } = await supabase.from('borrow_records')
        .select('*', { count: 'exact', head: true })
        .eq('school_id', getSchoolId())
        .eq('status', 'borrowed')
        .in('book_copy_id', (
            supabase.from('book_copies').select('id').eq('book_id', id)
        )); // Note: Supabase JS doesn't support subqueries in 'in'. 

    // Proper check: We just let DB handle cascade if we want, or do manual fetch.
    const { data: copies } = await supabase.from('book_copies').select('id').eq('book_id', id);
    if (copies && copies.length > 0) {
        const copyIds = copies.map(c => c.id);
        const { data: borrows } = await supabase.from('borrow_records')
            .select('id').eq('status', 'borrowed').in('book_copy_id', copyIds);
        
        if (borrows && borrows.length > 0) {
            throw new Error("Cannot delete book: there are active loans using copies of this book.");
        }
    }

    const { error } = await supabase.from('books').delete().eq('id', id).eq('school_id', getSchoolId());
    if (error) throw error;
    return true;
}

// --- COPIES ---

export async function bulkGenerateCopies(bookId, prefix, count) {
    // Calling RPC function for atomic generation
    const { data, error } = await supabase.rpc('bulk_generate_copies', {
        p_book_id: bookId,
        p_school_id: getSchoolId(),
        p_prefix: prefix,
        p_count: count
    });
    if (error) throw error;
    return data;
}

export async function createManualCopies(bookId, barcodes) {
    const schoolId = getSchoolId();
    const records = barcodes.map(code => ({
        book_id: bookId,
        school_id: schoolId,
        copy_code: code,
        status: 'available',
        condition: 'new'
    }));

    const { data, error } = await supabase.from('book_copies').insert(records).select();
    if (error) throw error;
    return data;
}

export async function getBookCopies(bookId) {
    const { data, error } = await supabase.from('book_copies')
        .select('*')
        .eq('book_id', bookId)
        .eq('school_id', getSchoolId());
    if (error) throw error;
    return data;
}

export async function updateBookCopy(id, updates) {
    const { data, error } = await supabase.from('book_copies').update(updates)
        .eq('id', id).eq('school_id', getSchoolId()).select().single();
    if (error) throw error;
    return data;
}

export async function searchAvailableCopies(searchQuery) {
    // 1. Search by copy_code directly
    const { data: codeData, error: e1 } = await supabase.from('book_copies')
        .select('*, books!inner(title, category, subject)')
        .eq('status', 'available')
        .eq('school_id', getSchoolId())
        .ilike('copy_code', `%${searchQuery}%`)
        .limit(10);
        
    if (e1) throw e1;

    // 2. Search by book title
    const { data: titleData, error: e2 } = await supabase.from('book_copies')
        .select('*, books!inner(title, category, subject)')
        .eq('status', 'available')
        .eq('school_id', getSchoolId())
        .ilike('books.title', `%${searchQuery}%`)
        .limit(10);
        
    if (e2) throw e2;

    // Merge and deduplicate
    const merged = [...(codeData || []), ...(titleData || [])];
    const unique = Array.from(new Map(merged.map(item => [item.id, item])).values());
    
    // Return top 10
    return unique.slice(0, 10);
}

// --- BORROW / RETURN ---

export async function issueBook(studentId, bookCopyId, dueDate, notes, issuedBy) {
    const { data, error } = await supabase.rpc('issue_book', {
        p_school_id: getSchoolId(),
        p_student_id: studentId,
        p_book_copy_id: bookCopyId,
        p_issued_by: issuedBy,
        p_due_date: dueDate,
        p_notes: notes
    });
    if (error) throw error;
    return data;
}

export async function returnBook(borrowRecordId, returnedTo, condition, notes) {
    const { data, error } = await supabase.rpc('return_book', {
        p_borrow_record_id: borrowRecordId,
        p_returned_to: returnedTo,
        p_condition: condition,
        p_notes: notes
    });
    if (error) throw error;
    return data;
}

export async function getActiveLoans(filter = {}) {
    let query = supabase.from('borrow_records')
      .select('*, students(name, adm_no), book_copies!inner(copy_code, condition, books(title, isbn))')
      .eq('status', 'borrowed')
      .eq('school_id', getSchoolId());

    if (filter.student_id) query = query.eq('student_id', filter.student_id);
    if (filter.copy_code) query = query.eq('book_copies.copy_code', filter.copy_code);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

export async function getStudentBorrowHistory(studentId) {
    const { data, error } = await supabase.from('borrow_records')
        .select('*, book_copies(copy_code, books(title, category))')
        .eq('student_id', studentId)
        .eq('school_id', getSchoolId())
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function getBookBorrowHistory(bookId) {
    const { data, error } = await supabase.from('borrow_records')
        .select('*, students(name, class, stream, adm_no), book_copies!inner(copy_code, book_id, books(title))')
        .eq('book_copies.book_id', bookId)
        .eq('school_id', getSchoolId())
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

// --- OVERDUE ---

export async function getOverdueBooks(filters = {}) {
    // due_date < TODAY AND status = 'borrowed'
    const today = new Date().toISOString().split('T')[0];
    let query = supabase.from('borrow_records')
        .select('*, students(id, name, class, stream, adm_no), book_copies(copy_code, books(title))')
        .eq('school_id', getSchoolId())
        .eq('status', 'borrowed')
        .lt('due_date', today);
    
    // Filtering by class if provided
    const { data, error } = await query;
    if (error) throw error;

    let results = data;
    if (filters.className) {
        results = results.filter(r => r.students && r.students.class === filters.className);
    }
    return results;
}

export async function markBookLost(borrowRecordId) {
    // 1. Get record
    const { data: record, error: e1 } = await supabase.from('borrow_records')
        .select('*').eq('id', borrowRecordId).single();
    if (e1) throw e1;

    // 2. Update copy + record
    await supabase.from('book_copies').update({ status: 'lost' }).eq('id', record.book_copy_id);
    await supabase.from('borrow_records').update({ status: 'lost', notes: 'Student must replace book' }).eq('id', borrowRecordId);

    return { record };
}

// Mark a lost book as replaced by the student
// Creates a NEW copy with a new code, resolves the old borrow record
export async function markBookReplaced(borrowRecordId) {
    // 1. Get the borrow record + lost copy info
    const { data: record, error: e1 } = await supabase.from('borrow_records')
        .select('*, book_copies(id, book_id, copy_code, school_id)')
        .eq('id', borrowRecordId)
        .single();
    if (e1) throw e1;
    if (record.status !== 'lost') throw new Error('Only lost books can be marked as replaced.');

    const lostCopy = record.book_copies;
    if (!lostCopy) throw new Error('Copy data not found.');

    // 2. Generate a new copy code: find the highest number for this book's prefix
    const prefix = lostCopy.copy_code.replace(/-\d+$/, ''); // e.g. MAT-F1-005 -> MAT-F1
    const { data: existingCopies } = await supabase.from('book_copies')
        .select('copy_code')
        .eq('book_id', lostCopy.book_id)
        .eq('school_id', lostCopy.school_id);

    let maxNum = 0;
    (existingCopies || []).forEach(c => {
        const match = c.copy_code.match(/-(\d+)$/);
        if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
    });
    const newCode = prefix + '-' + String(maxNum + 1).padStart(3, '0');

    // 3. Create replacement copy (new physical book, status: available)
    const { data: newCopy, error: e2 } = await supabase.from('book_copies').insert({
        book_id: lostCopy.book_id,
        school_id: lostCopy.school_id,
        copy_code: newCode,
        status: 'available',
        condition: 'new',
        notes: `Replacement for lost copy ${lostCopy.copy_code}`
    }).select().single();
    if (e2) throw e2;

    // 4. Mark old copy as 'replaced' (keep for audit trail)
    await supabase.from('book_copies').update({ 
        status: 'replaced', 
        notes: `Replaced by ${newCode}` 
    }).eq('id', lostCopy.id);

    // 5. Resolve the borrow record
    await supabase.from('borrow_records').update({ 
        status: 'replaced', 
        return_date: new Date().toISOString().split('T')[0],
        notes: `Student replaced with new copy: ${newCode}` 
    }).eq('id', borrowRecordId);

    return { newCopy, newCode, oldCode: lostCopy.copy_code };
}

export async function getLostBooks() {
    const { data, error } = await supabase.from('borrow_records')
        .select('*, students(id, name, class, adm_no), book_copies(copy_code, books(title))')
        .eq('school_id', getSchoolId())
        .eq('status', 'lost');
    if (error) throw error;
    return data || [];
}

export async function getAllActiveBorrows() {
    const { data, error } = await supabase.from('borrow_records')
        .select('id, borrow_date, due_date, status, students(id, name, class, adm_no), book_copies(copy_code, books(title, subject))')
        .eq('school_id', getSchoolId())
        .in('status', ['borrowed', 'overdue', 'lost'])
        .order('due_date', { ascending: true });
    if (error) throw error;
    return data || [];
}

// --- DASHBOARD REPORTS ---

export async function getLibraryDashboard() {
    const today = new Date().toISOString().split('T')[0];
    const schoolId = getSchoolId();

    const [titlesRes, copiesRes, borrowsRes, recentRes] = await Promise.all([
        supabase.from('books').select('*', { count: 'exact', head: true }).eq('school_id', schoolId),
        supabase.from('book_copies').select('status').eq('school_id', schoolId),
        supabase.from('borrow_records').select('due_date, status').eq('school_id', schoolId),
        supabase.from('borrow_records')
            .select('*, students(name), book_copies(copy_code, books(title))')
            .eq('school_id', schoolId)
            .order('created_at', { ascending: false })
            .limit(10)
    ]);

    const totalTitles = titlesRes.count || 0;
    const copies = copiesRes.data || [];
    const borrows = borrowsRes.data || [];
    const recent = recentRes.data || [];

    const totalCopies = copies.length;
    const availableCopies = copies.filter(c => c.status === 'available').length;
    const activeBorrows = borrows.filter(b => b.status === 'borrowed');
    const overdueCount = activeBorrows.filter(b => b.due_date < today).length;

    return {
        total_books: totalTitles,
        total_copies: totalCopies,
        available_copies: availableCopies,
        borrowed_count: activeBorrows.length,
        overdue_count: overdueCount,
        recent_activity: recent
    };
}
