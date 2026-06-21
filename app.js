// app.js - 完整业务版
const express = require('express');
const path = require('path');
const db = require('./db'); // 数据库连接池

const app = express();
const PORT = 3000;

// ---------- 中间件 ----------
app.use(express.json());

// 手动跨域配置
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// 托管前端静态文件（假设 frontend 与 backend 同级）
app.use(express.static(path.join(__dirname, '../frontend')));

// ============================================================
//  业务 API 路由
// ============================================================

// ---------- 1. 登录 ----------
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.query(
            `SELECT user_id, username, role, name 
             FROM User 
             WHERE username = ? AND password = SHA2(?, 256)`,
            [username, password]
        );
        if (rows.length === 0) {
            return res.status(401).json({ success: false, msg: '账号或密码错误' });
        }
        res.json({ success: true, user: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// ---------- 2. 获取教师课程 ----------
app.get('/api/teacher/:teacherId/courses', async (req, res) => {
    const { teacherId } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM Course WHERE teacher_id = ?', [teacherId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// ---------- 3. 获取学生课程 ----------
app.get('/api/student/:studentId/courses', async (req, res) => {
    const { studentId } = req.params;
    try {
        const [rows] = await db.query(`
            SELECT c.* 
            FROM Course c
            JOIN Course_Selection cs ON c.course_id = cs.course_id
            WHERE cs.student_id = ?
        `, [studentId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// ---------- 4. 发起签到（教师） ----------
// 发起签到（使用数据库时间，避免时区问题）
app.post('/api/session', async (req, res) => {
    const { course_id, duration_minutes, lat, lng } = req.body;
    const token = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
        const [result] = await db.query(
            `INSERT INTO Session (course_id, start_time, end_time, token, latitude, longitude)
             VALUES (?, NOW(), DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, ?, ?)`,
            [course_id, duration_minutes, token, lat, lng]
        );
        res.json({ success: true, session_id: result.insertId, token });
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});
// ---------- 5. 学生签到（调用存储过程，含事务防重） ----------
app.post('/api/checkin', async (req, res) => {
    const { student_id, session_id, lat, lng } = req.body;
    try {
        await db.query('CALL sp_student_check_in(?, ?, ?, ?)', [student_id, session_id, lat, lng]);
        const [rows] = await db.query(
            'SELECT status FROM Attendance_Record WHERE session_id = ? AND student_id = ?',
            [session_id, student_id]
        );
        res.json({ success: true, status: rows[0]?.status || 'absent' });
    } catch (err) {
        if (err.message.includes('Duplicate check-in')) {
            return res.status(400).json({ success: false, msg: '您已签到，请勿重复操作' });
        }
        res.status(500).json({ success: false, msg: err.message });
    }
});

// ---------- 6. 课程总体统计 ----------
app.get('/api/stats/:courseId', async (req, res) => {
    const { courseId } = req.params;
    try {
        const [[{ totalStudents }]] = await db.query(
            'SELECT COUNT(*) AS totalStudents FROM Course_Selection WHERE course_id = ?', [courseId]
        );
        const [[{ sessionsCount }]] = await db.query(
            'SELECT COUNT(*) AS sessionsCount FROM Session WHERE course_id = ?', [courseId]
        );
        const [[{ present, late }]] = await db.query(`
            SELECT 
                SUM(CASE WHEN ar.status = 'present' THEN 1 ELSE 0 END) AS present,
                SUM(CASE WHEN ar.status = 'late' THEN 1 ELSE 0 END) AS late
            FROM Attendance_Record ar
            JOIN Session s ON ar.session_id = s.session_id
            WHERE s.course_id = ?
        `, [courseId]);
        const totalSigned = (present || 0) + (late || 0);
        const totalExpected = (sessionsCount || 0) * (totalStudents || 0);
        const absent = totalExpected - totalSigned;
        const rate = totalExpected > 0 ? Math.round((present / totalExpected) * 100) : 0;

        const [[{ course_name }]] = await db.query(
            'SELECT course_name FROM Course WHERE course_id = ?', [courseId]
        );
        res.json({
            courseName: course_name,
            totalStudents: totalStudents || 0,
            sessionsCount: sessionsCount || 0,
            totalPresent: present || 0,
            totalLate: late || 0,
            totalAbsent: absent,
            rate
        });
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// ---------- 7. 获取课程所有学生的考勤明细（学号、姓名、出勤/迟到/缺勤次数） ----------
app.get('/api/course/:courseId/students/attendance', async (req, res) => {
    const { courseId } = req.params;
    try {
        const [rows] = await db.query(`
            SELECT 
                u.user_id AS student_id,
                u.name AS student_name,
                COUNT(DISTINCT s.session_id) AS total_sessions,
                SUM(CASE WHEN ar.status = 'present' THEN 1 ELSE 0 END) AS present_count,
                SUM(CASE WHEN ar.status = 'late' THEN 1 ELSE 0 END) AS late_count,
                (COUNT(DISTINCT s.session_id) - COUNT(ar.record_id)) AS absent_count
            FROM User u
            JOIN Course_Selection cs ON u.user_id = cs.student_id
            LEFT JOIN Session s ON s.course_id = cs.course_id
            LEFT JOIN Attendance_Record ar ON ar.session_id = s.session_id AND ar.student_id = u.user_id
            WHERE cs.course_id = ?
            GROUP BY u.user_id, u.name
            ORDER BY u.name
        `, [courseId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// ---------- 8. 获取课程当前进行中的签到会话（供学生一键签到使用） ----------
app.get('/api/course/:courseId/active-session', async (req, res) => {
    const { courseId } = req.params;
    try {
        const [rows] = await db.query(`
            SELECT session_id, start_time, end_time, token
            FROM Session
            WHERE course_id = ? AND NOW() BETWEEN start_time AND end_time
            LIMIT 1
        `, [courseId]);
        if (rows.length === 0) {
            return res.json({ active: false });
        }
        res.json({ active: true, session: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// ---------- 9. 测试接口（可选） ----------
app.get('/api/test', (req, res) => {
    res.json({ status: 'success', message: '后端服务正常运行中！' });
});

// ============================================================
//  启动服务器
// ============================================================
app.listen(PORT, () => {
    console.log(`✅ 服务器已启动: http://localhost:${PORT}`);
    console.log(`📂 静态目录: ${path.join(__dirname, '../frontend')}`);
});