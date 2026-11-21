import { Router } from 'express';
import { buildOverview } from '../services/analyticsService.js';

export const analyticsRouter = Router();

analyticsRouter.get('/overview', (req, res) => {
  const range = Number(req.query.range ?? 7) || 7;
  res.json({ overview: buildOverview(range) });
});
