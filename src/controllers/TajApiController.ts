
import { Router, Request, Response } from "express";
import { AppDataSource } from "../db/data-source"; // adjust path
import { Room } from "../entities/Room";
import { RoomType } from "../entities/RoomType";
import { RoomOccupancy } from "../entities/RoomOccupancy";
import { RoomOccupancyPhoto } from "../entities/RoomOccupancyPhoto";
import { Between, MoreThanOrEqual, LessThanOrEqual } from "typeorm";
import { RoomPhoto } from "../entities/RoomPhoto";
import { RoomExtra } from "../entities/RoomExtra";
import { RoomPrice } from "../entities/RoomPrice";

export class TajApiController {
    static search = async (req: Request, res: Response) => {
        try {
            const {
                hotel_id,
                check_in,
                check_out,
                rooms = 1,
                adults = 1,
                children = 0,
                } = req.body;

                if (!check_in || !check_out) {
                return res.status(400).json({ message: "check_in and check_out are required" });
                }

                const checkInDate  = new Date(check_in);
                const checkOutDate = new Date(check_out);

                if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
                return res.status(400).json({ message: "Invalid date format" });
                }

                if (checkInDate >= checkOutDate) {
                return res.status(400).json({ message: "check_out must be after check_in" });
                }

                const totalGuests  = Number(adults) + Number(children);
                const targetHotelId = hotel_id ?? 32;

                const nights = Math.ceil(
                (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)
                );

                // --- Query RoomOccupancies directly ---
                const occupancyRepo = AppDataSource.getRepository(RoomOccupancy);

                const occupancies = await occupancyRepo
                .createQueryBuilder("occ")
                .leftJoinAndSelect("occ.room", "room")
                .leftJoinAndSelect("room.room_type", "room_type")
                .leftJoinAndSelect("occ.photos", "photos")
                // .leftJoinAndSelect("occ.prices", "prices") // uncomment when RoomPrice relation is active
                .where("room.hotel_id = :hotelId", { hotelId: targetHotelId })
                //   .andWhere("occ.max_guests >= :totalGuests", { totalGuests })
                //   .andWhere("occ.rooms_left > 0")   // only available options
                .getMany();

                // --- Group by room (each room card) → occupancy options inside ---
                const groupedByRoom: Record<number, {
                room: {
                    id: number;
                    name: string;
                    room_name_id: string;
                    description: string;
                    size_sqft: number;
                    view_type: string;
                    view_from_room: string[];
                    bed_type: string;
                    image_url: string | null;
                    room_type: { id: number; name: string } | null;
                };
                occupancy_options: any[];
                }> = {};

                const results = occupancies.map((occ) => {
            const room = occ.room;

            return {
                occupancy_id:        occ.id,
                room_option_id:      occ.room_option_id,
                occupancy:           occ.occupancy,        // "Double" | "Triple" | "Quad"
                max_guests:          occ.max_guests,
                rooms_left:          occ.rooms_left,
                image_url:           occ.image_url,
                website_description: occ.website_description,
                base_meal_plan:      occ.base_meal_plan,
                photos:              occ.photos ?? [],
                pricing: {
                price_per_night: Number(room.price_per_night),
                total_price:     Number(room.price_per_night) * nights,
                nights,
                },
                room: {
                id:             room.id,
                name:           room.name,
                room_name_id:   room.room_name_id,
                description:    room.description,
                size_sqft:      room.size_sqft,
                view_type:      room.view_type,
                view_from_room: room.view_from_room,
                bed_type:       room.bed_type,
                image_url:      room.image_url,
                room_type:      room.room_type
                    ? { id: room.room_type.id, name: room.room_type.name }
                    : null,
                },
            };
            });

            return res.status(200).json({
            success: true,
            search_params: {
                hotel_id:     targetHotelId,
                check_in,
                check_out,
                nights,
                rooms:        Number(rooms),
                adults:       Number(adults),
                children:     Number(children),
                total_guests: totalGuests,
            },
            results,
            total_results: results.length,
            });

        } catch (error) {
            console.error("Room search error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }

    static search_room = async (req: Request, res: Response) => {
        try {
            const { room_option_id } = req.params;
            const { check_in, check_out } = req.query as { check_in: string; check_out: string };

            if (!check_in || !check_out) {
            return res.status(400).json({ message: "check_in and check_out are required" });
            }

            const checkInDate  = new Date(check_in);
            const checkOutDate = new Date(check_out);

            if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
            return res.status(400).json({ message: "Invalid date format" });
            }

            if (checkInDate >= checkOutDate) {
            return res.status(400).json({ message: "check_out must be after check_in" });
            }

            const nights = Math.ceil(
            (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)
            );

            // --- 1. Fetch the occupancy option ---
            const occupancyRepo = AppDataSource.getRepository(RoomOccupancy);

            const occupancy = await occupancyRepo
            .createQueryBuilder("occ")
            .leftJoinAndSelect("occ.room", "room")
            .leftJoinAndSelect("room.room_type", "room_type")
            .leftJoinAndSelect("occ.photos", "occ_photos")
            .where("occ.room_option_id = :room_option_id", { room_option_id })
            .getOne();

            if (!occupancy) {
            return res.status(404).json({ message: "Room occupancy option not found" });
            }

            // --- 2. Fetch room photos ---
            const roomPhotoRepo = AppDataSource.getRepository(RoomPhoto);
            const roomPhotos = await roomPhotoRepo.find({
            where: { room_id: occupancy.room_id },
            order: { position: "ASC" },
            });

            // --- 3. Fetch room extras (Extra Services section on the right) ---
            const roomExtraRepo = AppDataSource.getRepository(RoomExtra);
            const extras = await roomExtraRepo.find({
            where: { room_id: occupancy.room_id },
            });

            // --- 4. Fetch price for date range ---
            const roomPriceRepo = AppDataSource.getRepository(RoomPrice);

            const prices = await roomPriceRepo
            .createQueryBuilder("rp")
            .where("rp.room_option_id = :room_option_id", { room_option_id })
            .andWhere("rp.start_date <= :checkOut", { checkOut: check_out })
            .andWhere("rp.end_date >= :checkIn",   { checkIn: check_in })
            .orderBy("rp.start_date", "ASC")
            .getMany();

            // Calculate total cost across the date range
            // Each RoomPrice row covers a date range; sum up applicable days
            let total_cost_usd = 0;
            let price_per_night = 0;

            if (prices.length > 0) {
            // Simple approach: use the first matching price's selling_price_usd
            // For more accuracy you can iterate day by day
            price_per_night = Number(prices[0].selling_price_usd ?? 0);
            total_cost_usd  = price_per_night * nights;
            } else {
            // Fallback to room's base price_per_night
            price_per_night = Number(occupancy.room?.price_per_night ?? 0);
            total_cost_usd  = price_per_night * nights;
            }

            // --- 5. Build response ---
            const room = occupancy.room;

            return res.status(200).json({
            success: true,
            data: {
                // Occupancy option details
                occupancy: {
                id:                  occupancy.id,
                room_option_id:      occupancy.room_option_id,
                occupancy_type:      occupancy.occupancy,        // "Double" | "Triple" | "Quad"
                max_guests:          occupancy.max_guests,
                rooms_left:          occupancy.rooms_left,
                website_description: occupancy.website_description,
                base_meal_plan:      occupancy.base_meal_plan,
                image_url:           occupancy.image_url,
                photos:              occupancy.photos ?? [],
                },

                // Parent room info
                room: {
                id:             room.id,
                name:           room.name,
                room_name_id:   room.room_name_id,
                description:    room.description,
                size_sqft:      room.size_sqft,
                max_guests:     room.max_guests,
                bed_type:       room.bed_type,
                view_type:      room.view_type,
                view_from_room: room.view_from_room,
                image_url:      room.image_url,
                refundable:              room.refundable,
                free_cancellation_hours: room.free_cancellation_hours,
                breakfast_included:      room.breakfast_included,
                room_type: room.room_type
                    ? { id: room.room_type.id, name: room.room_type.name }
                    : null,
                },

                // All photos (room-level)
                photos: roomPhotos.map((p) => ({
                id:        p.id,
                image_url: p.image_url,
                position:  p.position,
                })),

                // Extra services (the checkboxes in your UI)
                extras: extras.map((e) => ({
                id:    e.id,
                name:  e.name,
                price: Number(e.price),
                })),

                // Pricing
                pricing: {
                check_in,
                check_out,
                nights,
                price_per_night,
                total_cost_usd,
                price_breakdown: prices.map((p) => ({
                    start_date:        p.start_date,
                    end_date:          p.end_date,
                    day_type:          p.day_type,
                    selling_price_usd: Number(p.selling_price_usd),
                    cost_sar:          Number(p.cost_sar),
                    hb_cost_sar:       Number(p.hb_cost_sar),
                    fb_cost_sar:       Number(p.fb_cost_sar),
                })),
                },
            },
            });

        } catch (error) {
            console.error("Occupancy detail error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }

}