const mysql = require('mysql2');
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',          // 你的MySQL用户名
    password: 'huateng666',
    database: 'attendance_db',
    timezone: '+08:00', 
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
module.exports = pool.promise();