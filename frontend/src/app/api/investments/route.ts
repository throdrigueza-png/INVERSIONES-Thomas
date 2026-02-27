import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// 1. Configuramos la conexión (igual que en wallet)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// GET: Traer todas las inversiones con su historial para las gráficas
export async function GET() {
    try {
        const investments = await prisma.investment.findMany({
            include: {
                history: { orderBy: { date: 'asc' } } // Trae los puntos de la gráfica en orden
            }
        });
        return NextResponse.json(investments);
    } catch (error) {
        console.error("Error en GET /api/investments:", error);
        return NextResponse.json({ error: "Error obteniendo inversiones" }, { status: 500 });
    }
}

// POST: Crear una nueva inversión (Ej: CDT o S&P 500)
export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { name, category, color, initialAmount, isLiquid, minBalance } = body;

        // Se crea la inversión y el primer punto en la gráfica automáticamente
        const newInvestment = await prisma.investment.create({
            data: {
                name,
                category,
                color,
                initialAmount: Number(initialAmount),
                currentAmount: Number(initialAmount),
                isLiquid,
                minBalance: Number(minBalance),
                history: {
                    create: { value: Number(initialAmount) } // Primer punto de la gráfica
                }
            },
            include: { history: true }
        });

        return NextResponse.json(newInvestment);
    } catch (error) {
        console.error("Error en POST /api/investments:", error);
        return NextResponse.json({ error: "Error creando inversión" }, { status: 500 });
    }
}

// PUT: Actualizar saldo de inversión (Inyectar o Retirar plata de un fondo)
export async function PUT(req: Request) {
    try {
        const body = await req.json();
        const { id, newAmount } = body;

        const updatedInvestment = await prisma.investment.update({
            where: { id },
            data: {
                currentAmount: Number(newAmount),
                history: {
                    create: { value: Number(newAmount) } // Agrega el nuevo punto a la gráfica
                }
            },
            include: { history: true }
        });

        return NextResponse.json(updatedInvestment);
    } catch (error) {
        console.error("Error en PUT /api/investments:", error);
        return NextResponse.json({ error: "Error actualizando fondo" }, { status: 500 });
    }
}