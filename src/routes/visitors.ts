import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.js';
import { visitors, visitorStats } from '../db/schema.js';
import { desc, eq, sql, and, gte } from 'drizzle-orm';

const visitorsRoutes: FastifyPluginAsync = async (fastify) => {
  
  // Get visitor statistics overview
  fastify.get('/stats', async (request, reply) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // Get today's stats directly from visitors table (real-time calculation)
      const todayVisitsQuery = await db.select({
        total: sql<number>`COUNT(*)`,
        unique: sql<number>`COUNT(DISTINCT ip)`
      })
      .from(visitors)
      .where(sql`DATE(timestamp) = ${today}`);

      // Get today's top pages directly from visitors table
      const todayTopPagesQuery = await db.select({
        path: visitors.path,
        count: sql<number>`COUNT(*)`
      })
      .from(visitors)
      .where(sql`DATE(timestamp) = ${today}`)
      .groupBy(visitors.path)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(10);

      const todayTopPages: Record<string, number> = {};
      todayTopPagesQuery.forEach(row => {
        todayTopPages[row.path] = row.count;
      });

      // Also check visitor_stats table as fallback
      const todayStats = await db.select()
        .from(visitorStats)
        .where(eq(visitorStats.date, today))
        .limit(1);

      // Get total visitors and visits
      const totalVisitors = await db.select({
        count: sql<number>`COUNT(DISTINCT ip)`
      }).from(visitors);

      const totalVisits = await db.select({
        count: sql<number>`COUNT(*)`
      }).from(visitors);

      // Get 7-day stats
      const sevenDayStats = await db.select({
        totalVisits: sql<number>`SUM(total_visits)`,
        uniqueVisitors: sql<number>`SUM(unique_visitors)`
      })
      .from(visitorStats)
      .where(gte(visitorStats.date, sevenDaysAgo));

      // Get 30-day stats
      const thirtyDayStats = await db.select({
        totalVisits: sql<number>`SUM(total_visits)`,
        uniqueVisitors: sql<number>`SUM(unique_visitors)`
      })
      .from(visitorStats)
      .where(gte(visitorStats.date, thirtyDaysAgo));

      // Get recent daily stats (last 30 days)
      const dailyStats = await db.select()
        .from(visitorStats)
        .where(gte(visitorStats.date, thirtyDaysAgo))
        .orderBy(desc(visitorStats.date))
        .limit(30);

      return reply.send({
        today: {
          visits: todayVisitsQuery[0]?.total || 0,
          unique: todayVisitsQuery[0]?.unique || 0,
          topPages: todayTopPages,
          topCountries: {} // Real-time country tracking would need GeoIP lookup
        },
        totals: {
          visits: totalVisits[0]?.count || 0,
          unique: totalVisitors[0]?.count || 0
        },
        sevenDays: {
          visits: sevenDayStats[0]?.totalVisits || 0,
          unique: sevenDayStats[0]?.uniqueVisitors || 0
        },
        thirtyDays: {
          visits: thirtyDayStats[0]?.totalVisits || 0,
          unique: thirtyDayStats[0]?.uniqueVisitors || 0
        },
        daily: dailyStats.map(stat => ({
          date: stat.date,
          visits: stat.totalVisits,
          unique: stat.uniqueVisitors,
          topPages: typeof stat.topPages === 'string' ? JSON.parse(stat.topPages) : stat.topPages || {},
          topCountries: typeof stat.topCountries === 'string' ? JSON.parse(stat.topCountries) : stat.topCountries || {}
        }))
      });

    } catch (error) {
      console.error('Error fetching visitor stats:', error);
      return reply.status(500).send({ error: 'Failed to fetch visitor statistics' });
    }
  });

  // Get recent visitors (last 100)
  fastify.get('/recent', async (request, reply) => {
    try {
      const recentVisitors = await db.select()
        .from(visitors)
        .orderBy(desc(visitors.timestamp))
        .limit(100);

      return reply.send({
        visitors: recentVisitors.map(visitor => ({
          id: visitor.id,
          path: visitor.path,
          timestamp: visitor.timestamp,
          country: visitor.country,
          city: visitor.city,
          referer: visitor.referer,
          isUnique: visitor.isUnique
        }))
      });

    } catch (error) {
      console.error('Error fetching recent visitors:', error);
      return reply.status(500).send({ error: 'Failed to fetch recent visitors' });
    }
  });

  // Manual trigger to update daily stats (for testing or cron jobs)
  fastify.post('/update-daily-stats', async (request, reply) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      // Count today's visits
      const todayVisits = await db.select({
        total: sql<number>`COUNT(*)`,
        unique: sql<number>`COUNT(DISTINCT ip)`
      })
      .from(visitors)
      .where(sql`DATE(timestamp) = ${today}`);

      // Get top pages for today
      const topPagesQuery = await db.select({
        path: visitors.path,
        count: sql<number>`COUNT(*)`
      })
      .from(visitors)
      .where(sql`DATE(timestamp) = ${today}`)
      .groupBy(visitors.path)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(10);

      const topPages: Record<string, number> = {};
      topPagesQuery.forEach(row => {
        topPages[row.path] = row.count;
      });

      // Get top countries for today
      const topCountriesQuery = await db.select({
        country: visitors.country,
        count: sql<number>`COUNT(*)`
      })
      .from(visitors)
      .where(and(
        sql`DATE(timestamp) = ${today}`,
        sql`country IS NOT NULL`
      ))
      .groupBy(visitors.country)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(10);

      const topCountries: Record<string, number> = {};
      topCountriesQuery.forEach(row => {
        if (row.country) {
          topCountries[row.country] = row.count;
        }
      });

      // Upsert daily stats - first try to update, then insert if not exists
      const existingStat = await db.select().from(visitorStats).where(eq(visitorStats.date, today)).limit(1);
      
      if (existingStat.length > 0) {
        // Update existing record
        await db.update(visitorStats)
          .set({
            totalVisits: todayVisits[0]?.total || 0,
            uniqueVisitors: todayVisits[0]?.unique || 0,
            topPages: topPages,
            topCountries: topCountries
          })
          .where(eq(visitorStats.date, today));
      } else {
        // Insert new record
        await db.insert(visitorStats)
          .values({
            date: today,
            totalVisits: todayVisits[0]?.total || 0,
            uniqueVisitors: todayVisits[0]?.unique || 0,
            topPages: topPages,
            topCountries: topCountries
          });
      }

      return reply.send({ 
        message: 'Daily stats updated successfully',
        stats: {
          date: today,
          totalVisits: todayVisits[0]?.total || 0,
          uniqueVisitors: todayVisits[0]?.unique || 0,
          topPages,
          topCountries
        }
      });

    } catch (error) {
      console.error('Error updating daily stats:', error);
      return reply.status(500).send({ error: 'Failed to update daily statistics' });
    }
  });

};

export default visitorsRoutes;
