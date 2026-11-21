import { Router } from 'express';
import { buildNutritionReport } from '../services/nutritionService.js';
import { readDateParam } from '../lib/units.js';

export const nutritionRouter = Router();

nutritionRouter.get('/', (req, res) => {
  const date = readDateParam(req.query.date);
  res.json({ report: buildNutritionReport(date) });
});
