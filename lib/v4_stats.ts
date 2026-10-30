import { SupabaseClient } from '@supabase/supabase-js';

interface CaseTrackingParams {
  ctvUsername: string;
  ctvName?: string;
  groupId: number;
  groupName: string;
  messageId: number;
  actionType: 'REACT' | 'REPLY';
  shiftId: string;
}

/**
 * Hàm kiểm tra xem CTV có đang nằm trong ca (dựa vào bảng pending_batches sẵn có của hệ thống)
 */
async function isValidCtvInShift(supabase: SupabaseClient, ctvUsername: string, shiftId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('pending_batches')
      .select('items')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data || !data.items) {
      return false;
    }

    const items = data.items;
    let shiftKey = '';

    const upperShift = shiftId.toUpperCase();
    if (upperShift.includes('SANG')) shiftKey = 'ctvSang';
    else if (upperShift.includes('CHIEU')) shiftKey = 'ctvChieu';
    else if (upperShift.includes('TOI')) shiftKey = 'ctvToi';

    if (!shiftKey || !items[shiftKey]) return false;

    const ctvList: string[] = items[shiftKey];
    return ctvList.includes(ctvUsername);
  } catch (err) {
    console.error('Lỗi check CTV từ pending_batches:', err);
    return false;
  }
}

/**
 * Ghi nhận case xử lý của CTV vào bảng ctv_case_tracking độc lập
 * Tự động check ca từ pending_batches và chống trùng lặp tại database
 */
export async function trackCtvCase(supabase: SupabaseClient, params: CaseTrackingParams) {
  try {
    if (!params.ctvUsername) return;

    // 1. Kiểm tra xem CTV có đang trong ca trực thực tế không
    const isInShift = await isValidCtvInShift(supabase, params.ctvUsername, params.shiftId);
    if (!isInShift) {
      console.log(`ℹ️ [V4 STATS] CTV @${params.ctvUsername} không có trong ca ${params.shiftId}, bỏ qua ghi nhận.`);
      return;
    }

    // 2. Upsert vào bảng ctv_case_tracking độc lập
    const { error } = await supabase
      .from('ctv_case_tracking')
      .upsert(
        {
          ctv_username: params.ctvUsername,
          ctv_name: params.ctvName || params.ctvUsername,
          group_id: params.groupId,
          group_name: params.groupName,
          message_id: params.messageId,
          action_type: params.actionType,
          shift_id: params.shiftId,
        },
        {
          onConflict: 'ctv_username,group_id,message_id,shift_id',
          ignoreDuplicates: true,
        }
      );

    if (error) {
      console.error('❌ [V4 STATS ERROR] Lỗi ghi nhận ctv_case_tracking:', error);
    } else {
      console.log(`✅ [V4 STATS] Đã ghi nhận case cho CTV trong ca: ${params.ctvUsername} (${params.actionType})`);
    }
  } catch (err) {
    console.error('❌ [V4 STATS EXCEPTION]:', err);
  }
}

/**
 * Hàm tổng hợp báo cáo cuối ca cho tất cả CTV
 */
export async function generateShiftReport(supabase: SupabaseClient, shiftId: string) {
  try {
    const { data, error } = await supabase
      .from('ctv_case_tracking')
      .select('ctv_username, ctv_name, message_id')
      .eq('shift_id', shiftId);

    if (error) {
      console.error('❌ [V4 REPORT ERROR] Không thể lấy dữ liệu báo cáo ca:', error);
      return null;
    }

    if (!data || data.length === 0) {
      return `📊 **BÁO CÁO CASE XỬ LÝ CUỐI CA (${shiftId})**\nKhông có dữ liệu xử lý trong ca này.`;
    }

    // Gom nhóm và đếm số case duy nhất cho mỗi CTV
    const statsMap: { [username: string]: { name: string; uniqueCases: Set<number> } } = {};

    data.forEach((row: any) => {
      const username = row.ctv_username;
      const ctvName = row.ctv_name || username;

      if (!statsMap[username]) {
        statsMap[username] = {
          name: ctvName,
          uniqueCases: new Set<number>(),
        };
      }
      statsMap[username].uniqueCases.add(row.message_id);
    });

    // Xây dựng nội dung báo cáo chuẩn định dạng
    let reportText = `📊 **BÁO CÁO CASE XỬ LÝ CUỐI CA (${shiftId})**\n\n| CTV | Số case xử lý |\n| :--- | :---: |\n`;

    Object.values(statsMap).forEach((stat) => {
      reportText += `| ${stat.name} | ${stat.uniqueCases.size} |\n`;
    });

    return reportText;
  } catch (err) {
    console.error('❌ [V4 REPORT EXCEPTION]:', err);
    return null;
  }
}