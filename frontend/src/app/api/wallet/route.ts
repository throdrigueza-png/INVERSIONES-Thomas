import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// 1. Configuramos la conexión con el nuevo estándar de Prisma
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// GET: Traer tu saldo líquido y últimos movimientos
export async function GET() {
    try {
        // Busca el perfil (si no existe, lo crea con saldo base de 300k para que tengas con qué jugar)
        let profile = await prisma.userProfile.findFirst();
        if (!profile) {
            profile = await prisma.userProfile.create({ data: { liquidBalance: 300000 } });
        }

        const transactions = await prisma.walletTransaction.findMany({
            orderBy: { date: 'desc' },
            take: 20 // Últimos 20 movimientos
        });

        return NextResponse.json({ liquidBalance: profile.liquidBalance, transactions });
    } catch (error) {
        console.error("Error en GET /api/wallet:", error);
        return NextResponse.json({ error: "Error conectando a la BD" }, { status: 500 });
    }
}

// POST: Registrar nuevo ingreso o gasto
export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { amount, type, description } = body;

        let profile = await prisma.userProfile.findFirst();
        if (!profile) return NextResponse.json({ error: "Perfil no encontrado" }, { status: 404 });

        // Regla de negocio: No gastar más de lo que hay
        if (type === "OUT" && amount > profile.liquidBalance) {
            return NextResponse.json({ error: "Fondos insuficientes" }, { status: 400 });
        }

        // Actualizamos saldo matemático
        const newBalance = type === "IN" ? profile.liquidBalance + amount : profile.liquidBalance - amount;

        // Transacción segura: Actualiza perfil y crea el registro al mismo tiempo
        const [updatedProfile, newTx] = await prisma.$transaction([
            prisma.userProfile.update({
                where: { id: profile.id },
                data: { liquidBalance: newBalance }
            }),
            prisma.walletTransaction.create({
                data: { amount: Number(amount), type, description }
            })
        ]);

        return NextResponse.json({ success: true, liquidBalance: updatedProfile.liquidBalance, transaction: newTx });
    } catch (error) {
        console.error("Error en POST /api/wallet:", error);
        return NextResponse.json({ error: "Error guardando transacción" }, { status: 500 });
    }
}